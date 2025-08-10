#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { ethers } from 'ethers';

const C = chalk;
const ENV_PATH = path.resolve(process.cwd(), '.env');
const WALLETS_PATH = path.resolve(process.cwd(), 'wallets.txt');
const LOG_PATH = path.resolve(process.cwd(), 'activity.log');

/* ============ Debug & Spinner ============ */
const DEBUG = (process.env.DEBUG || '').toString() === '1';
const SPINNER = !!process.stdout.isTTY && !DEBUG;
const makeSpinner = (text) => ora({ text, isEnabled: SPINNER });
process.on('unhandledRejection', (e) => console.error('\n[UNHANDLED]', e?.message || e));
process.on('uncaughtException',  (e) => console.error('\n[UNCAUGHT]',  e?.message || e));

/* ============ Activity Log helper ============ */
const ts = () => new Date().toISOString();
function logActivity(entry) {
  try {
    const line = JSON.stringify({ t: ts(), ...entry });
    fs.appendFileSync(LOG_PATH, line + os.EOL, 'utf8');
  } catch (e) {
    console.error('[LOG] gagal menulis log:', e.message || e);
  }
}

/* ============ Chain Presets ============ */
/**
 * Explorer API:
 * - Ethereum: Etherscan (ETHERSCAN_API_KEY)
 * - Base: Basescan (BASESCAN_API_KEY)
 * - Arbitrum: Arbiscan (ARBISCAN_API_KEY)
 * - Hyperliquid: biasanya TIDAK ada getabi — Auto(ABI) akan fallback minta Manual Sig
 */
const PRESETS = {
  'Ethereum Mainnet': {
    chainId: 1,
    rpc: process.env.ETH_MAINNET_RPC || 'https://eth.llamarpc.com',
    scan: {
      name: 'Etherscan',
      baseURL: 'https://api.etherscan.io',
      apiKey: process.env.ETHERSCAN_API_KEY || process.env.SCAN_API_KEY || ''
    },
    default1559: true,
    defaultGas: { maxFee: 30, maxPrio: 1.5, gasLimit: 250000 },
    seadroprouter: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
    defaultFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719'
  },
  'Base Mainnet': {
    chainId: 8453,
    rpc: process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org',
    scan: {
      name: 'Basescan',
      baseURL: 'https://api.basescan.org',
      apiKey: process.env.BASESCAN_API_KEY || process.env.SCAN_API_KEY || ''
    },
    default1559: true,
    defaultGas: { maxFee: 2, maxPrio: 1, gasLimit: 180000 },
    seadroprouter: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
    defaultFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719'
  },
  'Arbitrum One': {
    chainId: 42161,
    rpc: process.env.ARB_MAINNET_RPC || 'https://arb1.arbitrum.io/rpc',
    scan: {
      name: 'Arbiscan',
      baseURL: 'https://api.arbiscan.io',
      apiKey: process.env.ARBISCAN_API_KEY || process.env.SCAN_API_KEY || ''
    },
    default1559: true,
    defaultGas: { maxFee: 0.2, maxPrio: 0.05, gasLimit: 200000 },
    seadroprouter: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
    defaultFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719'
  },
  'Hyperliquid EVM': {
    chainId: Number(process.env.HL_CHAIN_ID || 0) || 0,
    rpc: process.env.HL_RPC || 'https://rpc.hyperliquid.xyz/evm', // ganti jika kamu punya RPC lain
    scan: {
      name: 'Explorer API',
      baseURL: process.env.HL_SCAN_BASEURL || '', // kebanyakan belum ada getabi
      apiKey: process.env.HL_SCAN_API_KEY || ''
    },
    default1559: true,
    defaultGas: { maxFee: 1, maxPrio: 0.2, gasLimit: 200000 },
    seadroprouter: process.env.HL_SEADROP_ROUTER || '0x0000000000000000000000000000000000000000',
    defaultFeeRecipient: process.env.HL_FEE_RECIPIENT || '0x0000000000000000000000000000000000000000'
  },
  'Custom / Manual': {
    chainId: Number(process.env.CHAIN_ID || 0) || 0,
    rpc: process.env.RPC_URL || '',
    scan: {
      name: 'Explorer API',
      baseURL: process.env.SCAN_BASEURL || '',
      apiKey: process.env.SCAN_API_KEY || ''
    },
    default1559: true,
    defaultGas: { maxFee: '', maxPrio: '', gasLimit: 200000 },
    seadroprouter: process.env.SEA_DROP_ROUTER || '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
    defaultFeeRecipient: process.env.FEE_RECIPIENT || '0x0000a26b00c1F0DF003000390027140000fAa719'
  }
};

const state = {
  preset: process.env.NETWORK || 'Base Mainnet',
  rpcUrl: '',
  chainId: 0,
  scan: { baseURL: '', apiKey: '', name: '' },

  // generic
  contract: (process.env.CONTRACT_ADDRESS || '').trim(),
  mintFuncSig: process.env.MINT_FUNC_SIG || 'function mint(uint256)',
  mintAmount: Number(process.env.MINT_AMOUNT || 1),
  mintPrice: process.env.MINT_PRICE ? String(process.env.MINT_PRICE) : '0',

  // gas
  gasLimit: Number(process.env.GAS_LIMIT || 200000),
  use1559: true,
  maxFee: process.env.MAX_FEE_GWEI ? Number(process.env.MAX_FEE_GWEI) : null,
  maxPrio: process.env.MAX_PRIORITY_GWEI ? Number(process.env.MAX_PRIORITY_GWEI) : null,

  // SeaDrop
  seadroprouter: process.env.SEA_DROP_ROUTER || '',
  nftContractAddr: (process.env.NFT_CONTRACT || '').trim(),
  feeRecipient: process.env.FEE_RECIPIENT || '',

  // custom router (opsional)
  customRouter: process.env.CUSTOM_ROUTER || '',
  customFuncSig: process.env.CUSTOM_FUNC_SIG || 'function purchase(uint256) payable',
  customArgsCsv: process.env.CUSTOM_ARGS_CSV || '',

  // runtime
  retries: Number(process.env.RETRY_ATTEMPTS || 2),
  conc: Math.max(1, Number(process.env.CONCURRENCY || 2))
};

/* ============ Wallet status cache ============ */
let lastWalletStatus = { total: 0, valid: 0, invalid: 0, sample: [] };
const shortAddr = (a) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : '';

/* ============ Provider factory ============ */
async function getProvider() {
  const provider = new ethers.providers.JsonRpcProvider({ url: state.rpcUrl, timeout: 20000 });
  if (DEBUG) {
    console.log('[RPC] connect →', state.rpcUrl);
    const head = await provider.getBlockNumber().catch(e => `(fail: ${e.message})`);
    console.log('[RPC] head =', head);
  }
  return provider;
}

/* ============ UI ============ */
function banner() {
  console.clear();
  console.log(C.greenBright('================================'));
  console.log(C.greenBright('  NFT Mint Bot – Multi Wallet   '));
  console.log(C.greenBright('================================\n'));
  console.log(`${C.gray('Preset            :')} ${state.preset}`);
  console.log(`${C.gray('RPC URL           :')} ${state.rpcUrl}`);
  console.log(`${C.gray('Contract          :')} ${state.contract || C.red('(belum di-set)')}`);
  console.log(`${C.gray('Mint Amount       :')} ${state.mintAmount}`);
  console.log(`${C.gray('Mint Price/NFT    :')} ${state.mintPrice}`);
  console.log(`${C.gray('Gas Limit         :')} ${state.gasLimit}`);
  console.log(`${C.gray('EIP-1559          :')} ${state.use1559 ? 'YA' : 'TIDAK'}`);
  console.log(`${C.gray('maxFee / maxPrio  :')} ${state.maxFee ?? '(auto)'} / ${state.maxPrio ?? '(auto)'} gwei`);
  console.log(`${C.gray('Concurrency       :')} ${state.conc}`);
  console.log(`${C.gray('SeaDrop Router    :')} ${state.seadroprouter || '-'}`);
  console.log(`${C.gray('Fee Recipient     :')} ${state.feeRecipient || '-'}`);
  console.log(`${C.gray('Wallets (status)  :')} total=${lastWalletStatus.total}, valid=${lastWalletStatus.valid}, invalid=${lastWalletStatus.invalid}`);
  if (lastWalletStatus.sample?.length) console.log(`${C.gray('Sample            :')} ${lastWalletStatus.sample.join(', ')}`);
  console.log('');
}

/* ============ Preset ============ */
function setPreset(presetName) {
  const p = PRESETS[presetName];
  state.preset = presetName;
  state.rpcUrl = p.rpc;
  state.chainId = p.chainId;
  state.scan = { ...p.scan };
  state.use1559 = p.default1559;
  state.maxFee = p.defaultGas.maxFee === '' ? null : Number(p.defaultGas.maxFee);
  state.maxPrio = p.defaultGas.maxPrio === '' ? null : Number(p.defaultGas.maxPrio);
  state.gasLimit = p.defaultGas.gasLimit;
  state.seadroprouter = state.seadroprouter || p.seadroprouter;
  state.feeRecipient = state.feeRecipient || p.defaultFeeRecipient;
}

/* ============ Helpers ============ */
function getOverrides(gasLimitOverride) {
  const ov = { gasLimit: ethers.BigNumber.from(gasLimitOverride ?? state.gasLimit) };
  if (state.use1559) {
    if (state.maxFee != null) ov.maxFeePerGas = ethers.utils.parseUnits(String(state.maxFee), 'gwei');
    if (state.maxPrio != null) ov.maxPriorityFeePerGas = ethers.utils.parseUnits(String(state.maxPrio), 'gwei');
  }
  return ov;
}
function ifaceFromSig(sig) {
  try { return new ethers.utils.Interface([sig]); }
  catch { throw new Error(`Signature tidak valid: ${sig}`); }
}
async function fetchAbiFromScan(address) {
  if (!state.scan.baseURL || !state.scan.apiKey) return null; // e.g. Hyperliquid
  const spinner = makeSpinner(`Ambil ABI dari ${state.scan.name}...`).start();
  try {
    const url = `${state.scan.baseURL}/api?module=contract&action=getabi&address=${address}&apikey=${state.scan.apiKey}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (data.status === '1' && data.result) {
      spinner.succeed(`${state.scan.name} ABI OK`);
      return JSON.parse(data.result);
    } else {
      spinner.fail(`${state.scan.name} ABI gagal: ${data.result || 'unknown'}`);
      return null;
    }
  } catch (e) {
    spinner.fail(`Error fetch ABI: ${e.message}`);
    return null;
  }
}
function pickMintLikeFunctions(abi) {
  const iface = new ethers.utils.Interface(abi);
  const candidates = [];
  for (const f of Object.values(iface.functions)) {
    const name = f.name.toLowerCase();
    if (name.includes('mint')) candidates.push(f);
  }
  const score = (f) => {
    const n = f.name.toLowerCase();
    let s = 0;
    if (n === 'mint') s += 5;
    if (n.includes('public')) s += 3;
    if (f.inputs.length <= 2) s += 1;
    return s;
  };
  return candidates.sort((a,b)=>score(b)-score(a));
}
async function staticTry(contractAddr, func, wallet, valueWei, args) {
  const contract = new ethers.Contract(contractAddr, [func.format()], wallet);
  try {
    await contract.callStatic[func.name](...args, { value: valueWei });
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: (e.error?.message || e.message || '').slice(0,180) };
  }
}

/* ============ Wallets ============ */
function ensureWalletsFile() {
  if (!fs.existsSync(WALLETS_PATH)) fs.writeFileSync(WALLETS_PATH, '', 'utf8');
}
function loadWalletKeys() {
  ensureWalletsFile();
  return fs.readFileSync(WALLETS_PATH, 'utf8')
    .split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
}
async function computeWalletStatus(doNetworkCheck = false) {
  const keys = loadWalletKeys();
  const rows = [];
  let total = keys.length, valid = 0, invalid = 0;

  const envPk = (process.env.PRIVATE_KEY || '').trim();
  if (envPk) { total += 1; rows.push({ source: '.env', pk: envPk }); }
  keys.forEach((pk, i) => rows.push({ source: `wallets.txt:${i+1}`, pk }));

  const provider = doNetworkCheck ? await getProvider() : null;

  const out = [];
  for (const row of rows) {
    let address = '', ok = false, reason = '';
    try {
      const w = new ethers.Wallet(row.pk);
      address = w.address; ok = true;
    } catch {
      ok = false; reason = 'invalid private key'; invalid++;
    }
    let balance = null, nonce = null;
    if (ok && doNetworkCheck && provider) {
      try {
        [balance, nonce] = await Promise.all([
          provider.getBalance(address),
          provider.getTransactionCount(address)
        ]);
      } catch (e) {
        reason = reason || (e.message || 'rpc error');
      }
    }
    if (ok) valid++;
    out.push({
      source: row.source,
      address,
      ok,
      reason,
      balanceEth: balance != null ? ethers.utils.formatEther(balance) : null,
      nonce
    });
  }

  lastWalletStatus = {
    total, valid, invalid,
    sample: out.filter(r=>r.ok).slice(0,3).map(r=>shortAddr(r.address))
  };
  return out;
}
/* ============ Gas & Funds Helpers ============ */
async function estimateWithBuffer(txPromise, bufferPct = 20, fallbackGasLimit = state.gasLimit) {
  try {
    const est = await txPromise;
    const buff = est.mul(100 + bufferPct).div(100);
    return buff.lt(ethers.BigNumber.from(fallbackGasLimit)) ? buff : ethers.BigNumber.from(fallbackGasLimit);
  } catch {
    return ethers.BigNumber.from(fallbackGasLimit);
  }
}
async function ensureFundsForTx(provider, from, valueWei, maxFeeGwei, gasLimit) {
  const bal = await provider.getBalance(from);
  const feeCap = (maxFeeGwei != null) ? ethers.utils.parseUnits(String(maxFeeGwei), 'gwei') : ethers.constants.Zero;
  const maxFeeTotal = feeCap.mul(ethers.BigNumber.from(gasLimit));
  const need = valueWei.add(maxFeeTotal);
  return { ok: bal.gte(need), balance: bal, need };
}

/* ============ Revert Decoder (best-effort) ============ */
function tryDecodeRevert(iface, data) {
  try { return iface.parseError(data)?.name || ''; } catch { return ''; }
}
const SEA_ERRORS_IFACE = new ethers.utils.Interface([
  'error PublicDropInactive()',
  'error MintCapExceeded(address)',
  'error MintQuantityExceedsMaxMintable()',
  'error MintPriceNotMet(uint256,uint256)',
  'error MintNotPaid()',
  'error MintPaused()',
  'error InvalidFeeRecipient()'
]);

/* ============ Core Mint Single Helpers ============ */
async function mintGenericDetected_single(wallet, detected) {
  const { func } = detected;
  const contract = new ethers.Contract(state.contract, [func.format()], wallet);
  const priceStr = String(state.mintPrice || '0').trim();
const valueWei = ethers.utils.parseEther(priceStr);
  const args = [];
  if (func.inputs.length >= 1 && func.inputs[0].type.startsWith('uint')) {
    args.push(ethers.BigNumber.from(state.mintAmount));
  }
  if (DEBUG) console.log('[GENERIC/AUTO] func=', func.name, 'args=', args, 'value=', state.mintPrice);

  // estimate + preflight
  const gasLimitToUse = await estimateWithBuffer(
    contract.estimateGas[func.name](...args, { value: valueWei }),
    20, state.gasLimit
  );
  const { ok, balance, need } = await ensureFundsForTx(wallet.provider, wallet.address, valueWei, state.maxFee, gasLimitToUse.toNumber());
  if (!ok) throw new Error(`Insufficient funds: bal=${ethers.utils.formatEther(balance)} need=${ethers.utils.formatEther(need)}`);

  // callStatic guard
  await contract.callStatic[func.name](...args, { value: valueWei }).catch((e)=>{
    throw new Error(`callStatic revert: ${(e?.error?.message || e?.message || '').split('\n')[0]}`);
  });

  const tx = await contract[func.name](...args, { ...getOverrides(gasLimitToUse), value: valueWei });
  const rec = await tx.wait();
  if (rec.status === 0) throw new Error('mined but reverted (generic/auto)');
  return rec;
}

async function mintGenericManual_single(wallet) {
  const iface = ifaceFromSig(state.mintFuncSig);
  const func = iface.fragments[0];
  const contract = new ethers.Contract(state.contract, iface, wallet);
  const args = [];
  if (func.inputs.length >= 1 && func.inputs[0].type.startsWith('uint')) {
    args.push(ethers.BigNumber.from(state.mintAmount));
  }
  const priceStr = String(state.mintPrice || '0').trim();
const valueWei = ethers.utils.parseEther(priceStr);
  if (DEBUG) console.log('[GENERIC/MANUAL] func=', func.name, 'args=', args, 'value=', state.mintPrice);

  // estimate + preflight
  const gasLimitToUse = await estimateWithBuffer(
    contract.estimateGas[func.name](...args, { value: valueWei }),
    20, state.gasLimit
  );
  const { ok, balance, need } = await ensureFundsForTx(wallet.provider, wallet.address, valueWei, state.maxFee, gasLimitToUse.toNumber());
  if (!ok) throw new Error(`Insufficient funds: bal=${ethers.utils.formatEther(balance)} need=${ethers.utils.formatEther(need)}`);

  // callStatic guard
  await contract.callStatic[func.name](...args, { value: valueWei }).catch((e)=>{
    throw new Error(`callStatic revert: ${(e?.error?.message || e?.message || '').split('\n')[0]}`);
  });

  const tx = await contract[func.name](...args, { ...getOverrides(gasLimitToUse), value: valueWei });
  const rec = await tx.wait();
  if (rec.status === 0) throw new Error('mined but reverted (generic/manual)');
  return rec;
}

async function mintSeaDropPublic_single(wallet) {
  if (!state.nftContractAddr) state.nftContractAddr = state.contract;
  const abi = ['function mintPublic(address,address,address,uint256) payable'];
  const router = new ethers.Contract(state.seadroprouter, abi, wallet);
  const priceStr = String(state.mintPrice || '0').trim();
const value = ethers.utils.parseEther(priceStr);

  if (!state.seadroprouter || state.seadroprouter.toLowerCase() === state.nftContractAddr.toLowerCase()) {
    throw new Error('Router tidak valid atau sama dengan NFT contract.');
  }

  // estimate gas with buffer
  const gasLimitToUse = await estimateWithBuffer(
    router.estimateGas.mintPublic(
      state.nftContractAddr, state.feeRecipient, wallet.address,
      ethers.BigNumber.from(state.mintAmount), { value }
    ),
    20, state.gasLimit
  );

  // callStatic - ambil reason bila gagal
  try {
    await router.callStatic.mintPublic(
      state.nftContractAddr,
      state.feeRecipient,
      wallet.address,
      ethers.BigNumber.from(state.mintAmount),
      { value }
    );
  } catch (e) {
    const raw = e?.error?.data || e?.data;
    const decoded = raw ? tryDecodeRevert(SEA_ERRORS_IFACE, raw) : '';
    const reason = decoded || (e?.error?.message || e?.message || 'callStatic revert');
    throw new Error(reason);
  }

  // preflight balance
  const { ok, balance, need } = await ensureFundsForTx(wallet.provider, wallet.address, value, state.maxFee, gasLimitToUse.toNumber());
  if (!ok) throw new Error(`Insufficient funds: bal=${ethers.utils.formatEther(balance)} need=${ethers.utils.formatEther(need)}`);

  // broadcast
  const tx = await router.mintPublic(
    state.nftContractAddr,
    state.feeRecipient,
    wallet.address,
    ethers.BigNumber.from(state.mintAmount),
    { ...getOverrides(gasLimitToUse), value }
  );
  const rec = await tx.wait();

  if (rec.status === 0) {
    // mined but reverted → coba derive reason via callStatic lagi
    let reason = 'reverted';
    try {
      await router.callStatic.mintPublic(
        state.nftContractAddr, state.feeRecipient, wallet.address,
        ethers.BigNumber.from(state.mintAmount), { value }
      );
    } catch (er) {
      const raw = er?.error?.data || er?.data;
      const name = raw ? tryDecodeRevert(SEA_ERRORS_IFACE, raw) : '';
      reason = name || (er?.error?.message || er?.message || reason);
    }
    throw new Error(`mined but reverted: ${reason}`);
  }
  return rec;
}

/* ============ Detect (Auto ABI) ============ */
async function detectMintFunction(wallet) {
  const spinner = makeSpinner('Deteksi fungsi mint (ambil ABI)...').start();
  const abi = await fetchAbiFromScan(state.contract);
  if (!abi) {
    spinner.fail('Gagal mengambil ABI dari explorer. Gunakan menu Generic (Manual Sig).');
    return null;
  }
  const funcs = pickMintLikeFunctions(abi);
  if (funcs.length === 0) { spinner.fail('Tidak ada fungsi mint-like di ABI.'); return null; }

  const priceStr = String(state.mintPrice || '0').trim();
const valueWei = ethers.utils.parseEther(priceStr);
  for (const f of funcs) {
    const args = [];
    if (f.inputs.length >= 1 && f.inputs[0].type.startsWith('uint')) {
      args.push(ethers.BigNumber.from(state.mintAmount));
    }
    const test = await staticTry(state.contract, f, wallet, valueWei, args);
    if (DEBUG) console.log('[DETECT]', f.name, '→', test.ok ? 'OK' : `FAIL (${test.reason})`);
    if (test.ok) {
      spinner.succeed(`Fungsi terdeteksi: ${f.name}(${f.inputs.map(i=>i.type).join(',')})`);
      return { func: f };
    }
  }
  spinner.fail('Semua kandidat mint-like gagal (mungkin butuh signature/proof/router).');
  return null;
}

/* ============ Multi Wallet Runner ============ */
async function runWithWallets(executor, title) {
  const keys = loadWalletKeys();
  if (keys.length === 0) { console.log(C.yellow('wallets.txt kosong')); return; }
  const provider = await getProvider();
  console.log(C.gray(`Menjalankan ${keys.length} wallet (conc=${state.conc}) → ${title}\n`));

  const chunks = [];
  for (let i=0; i<keys.length; i+=state.conc) chunks.push(keys.slice(i, i+state.conc));

  let success = 0, fail = 0;
  for (const batch of chunks) {
    await Promise.all(batch.map(async (pk) => {
      const wallet = new ethers.Wallet(pk, provider);
      const spinner = makeSpinner(`[${wallet.address.slice(0,6)}…] broadcast...`).start();
      const startAt = Date.now();
      try {
        const rec = await executor(wallet);
        spinner.succeed(`[${wallet.address.slice(0,6)}…] mined in block ${rec.blockNumber}`);
        success++;
        logActivity({
          type: 'multi_wallet',
          title,
          ok: true,
          block: rec.blockNumber,
          from: wallet.address,
          ms: Date.now() - startAt
        });
      } catch (e) {
        const msg = String(e?.message || e).split('\n')[0];
        spinner.fail(`[${wallet.address.slice(0,6)}…] ${msg}`);
        fail++;
        logActivity({
          type: 'multi_wallet',
          title,
          ok: false,
          error: msg,
          from: wallet.address,
          ms: Date.now() - startAt
        });
      }
    }));
  }
  console.log(C.green(`\nSelesai. Sukses: ${success} | Gagal: ${fail}\n`));
}
/* ============ Menus & Actions ============ */
async function mainMenu() {
  if (!state.rpcUrl) await choosePreset();
  banner();
  const { choice } = await inquirer.prompt([{
    type: 'list',
    name: 'choice',
    message: C.cyan('Pilih opsi:'),
    pageSize: 18,
    choices: [
      '0) Pilih Network Preset',
      '1) Tempel Contract Address (validasi)',
      '2) Set Mint Price & Amount',
      '3) Set Gas & Concurrency',
      '4) Wallet Manager (add/remove/clear)',
      '4.5) Wallet Status / Validate',
      new inquirer.Separator(),
      '5) Mint – AUTO (deteksi ABI) [Single]',
      '6) Mint – AUTO (deteksi ABI) [Multi]',
      '7) Mint – SeaDrop Public [Single]',
      '8) Mint – SeaDrop Public [Multi]',
      '9) Mint – Generic (Manual Sig) [Single]',
      '10) Mint – Generic (Manual Sig) [Multi]',
      new inquirer.Separator(),
      'Simpan ke .env',
      'Keluar'
    ]
  }]);

  switch (choice) {
    case '0) Pilih Network Preset': await choosePreset(); break;
    case '1) Tempel Contract Address (validasi)': await setContract(); break;
    case '2) Set Mint Price & Amount': await setMintParams(); break;
    case '3) Set Gas & Concurrency': await setGas(); break;
    case '4) Wallet Manager (add/remove/clear)': await walletManager(); break;
    case '4.5) Wallet Status / Validate': await walletStatusMenu(); break;

    case '5) Mint – AUTO (deteksi ABI) [Single]': await runAutoSingle(); break;
    case '6) Mint – AUTO (deteksi ABI) [Multi]': await runAutoMulti(); break;

    case '7) Mint – SeaDrop Public [Single]': await runSeaDropSingle(); break;
    case '8) Mint – SeaDrop Public [Multi]': await runSeaDropMulti(); break;

    case '9) Mint – Generic (Manual Sig) [Single]': await runGenericManualSingle(); break;
    case '10) Mint – Generic (Manual Sig) [Multi]': await runGenericManualMulti(); break;

    case 'Simpan ke .env': await saveEnv(); break;
    default: process.exit(0);
  }
  await mainMenu();
}

async function choosePreset() {
  const { presetName } = await inquirer.prompt([{
    type: 'list', name: 'presetName', message: 'Pilih network:', choices: Object.keys(PRESETS)
  }]);
  setPreset(presetName);
  if (!state.rpcUrl) {
    const { rpc } = await inquirer.prompt([{ name: 'rpc', message: 'RPC URL:', default: '' }]);
    state.rpcUrl = rpc.trim();
  }
}

/* ---- Contract input + VALIDASI + LOG ---- */
async function setContract() {
  const { addr } = await inquirer.prompt([{ name: 'addr', message: 'Contract Address (0x...):', default: state.contract }]);
  const input = (addr || '').trim();

  if (!ethers.utils.isAddress(input)) {
    const reason = 'Alamat tidak valid (bukan 0x...)';
    console.log(C.red('❌ ' + reason));
    logActivity({ type: 'contract_set', ok: false, reason, address: input, rpc: state.rpcUrl });
    await inquirer.prompt([{ type: 'input', name: 'x', message: 'Enter untuk kembali...' }]);
    return;
  }

  const provider = await getProvider();
  let code = '0x';
  try { code = await provider.getCode(input); } catch (e) {}
  if (!code || code === '0x') {
    const reason = 'Alamat bukan kontrak (bytecode kosong)';
    console.log(C.red('❌ ' + reason));
    logActivity({ type: 'contract_set', ok: false, reason, address: input, rpc: state.rpcUrl });
    await inquirer.prompt([{ type: 'input', name: 'x', message: 'Enter untuk kembali...' }]);
    return;
  }

  // Metadata best-effort
  let name = null, symbol = null, standard = 'Unknown';
  try {
    const ercMeta = new ethers.Contract(input, [
      'function name() view returns (string)',
      'function symbol() view returns (string)'
    ], provider);
    [name, symbol] = await Promise.allSettled([ercMeta.name(), ercMeta.symbol()])
      .then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));

    const erc165 = new ethers.Contract(input, [
      'function supportsInterface(bytes4) view returns (bool)'
    ], provider);
    const is721  = await erc165.supportsInterface('0x80ac58cd').catch(()=>false);
    const is1155 = await erc165.supportsInterface('0xd9b67a26').catch(()=>false);
    if (is721) standard = 'ERC721';
    else if (is1155) standard = 'ERC1155';
  } catch {}

  state.contract = input;
  state.nftContractAddr = input;

  const msg = `✓ Contract valid${name || symbol ? ` (${name || ''}${name && symbol ? ' / ' : ''}${symbol || ''})` : ''} [${standard}]`;
  console.log(C.green(msg));
  logActivity({
    type: 'contract_set',
    ok: true,
    address: input,
    standard,
    name, symbol,
    rpc: state.rpcUrl
  });
}

async function setMintParams() {
  const a = await inquirer.prompt([
    { name: 'price', message: 'Mint Price per NFT (native token):', default: state.mintPrice },
    { name: 'amount', message: 'Mint Amount:', default: String(state.mintAmount), validate: v => (+v>0) ? true : 'Harus > 0' }
  ]);
  state.mintPrice = String(a.price).trim();
  state.mintAmount = Number(a.amount);
}

async function setGas() {
  const a = await inquirer.prompt([
    { type: 'confirm', name: 'use', message: 'Pakai EIP-1559 override?', default: state.use1559 },
    { name: 'gasLimit', message: 'Gas Limit:', default: String(state.gasLimit) },
    { name: 'maxFee', message: 'maxFeePerGas (gwei) (kosong=auto):', default: state.maxFee ?? '' },
    { name: 'maxPrio', message: 'maxPriorityFee (gwei) (kosong=auto):', default: state.maxPrio ?? '' },
    { name: 'conc', message: 'Concurrency (wallet sekaligus):', default: String(state.conc) }
  ]);
  state.use1559 = a.use;
  state.gasLimit = Number(a.gasLimit);
  state.maxFee = a.maxFee === '' ? null : Number(a.maxFee);
  state.maxPrio = a.maxPrio === '' ? null : Number(a.maxPrio);
  state.conc = Math.max(1, Number(a.conc));
}

async function walletManager() {
  ensureWalletsFile();
  const list = fs.readFileSync(WALLETS_PATH, 'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  console.log('\nwallets.txt:');
  if (list.length === 0) console.log(C.gray('(kosong)'));
  else list.forEach((w,i)=>console.log(`${i+1}. ${w.slice(0,10)}...${w.slice(-6)}`));
  console.log('');

  const { action } = await inquirer.prompt([{
    type: 'list', name: 'action', message: 'Aksi:', choices: ['Tambah', 'Hapus 1 baris', 'Kosongkan', 'Kembali']
  }]);

  if (action === 'Tambah') {
    const { pk } = await inquirer.prompt([{ name: 'pk', message: 'Private key (0x...):' }]);
    fs.appendFileSync(WALLETS_PATH, pk.trim() + os.EOL);
    console.log(C.green('Ditambahkan.\n'));
  }
  if (action === 'Kosongkan') {
    fs.writeFileSync(WALLETS_PATH, '', 'utf8');
    console.log(C.yellow('Dikosongkan.\n'));
  }
  if (action === 'Hapus 1 baris') {
    if (list.length === 0) { console.log(C.yellow('Tidak ada baris.')); return; }
    const { idx } = await inquirer.prompt([{
      name: 'idx', message: `Index yang dihapus (1..${list.length}):`, validate: v => {
        const n = Number(v); return (n>=1 && n<=list.length) ? true : 'Index tidak valid';
      }
    }]);
    const n = Number(idx);
    const kept = list.filter((_,i)=>i!==n-1);
    fs.writeFileSync(WALLETS_PATH, kept.join(os.EOL)+os.EOL, 'utf8');
    console.log(C.green(`Baris ${n} dihapus.\n`));
  }
}

async function walletStatusMenu() {
  const { net } = await inquirer.prompt([{
    type: 'confirm',
    name: 'net',
    message: 'Cek balance & nonce lewat RPC?',
    default: true
  }]);

  const spinner = makeSpinner(net ? 'Cek wallet + RPC...' : 'Cek wallet...').start();
  const rows = await computeWalletStatus(net);
  spinner.stop();

  console.log('');
  console.log(C.gray('Sumber'.padEnd(20)), C.gray('Address'.padEnd(44)), C.gray('OK'.padEnd(4)), C.gray('Balance'.padEnd(16)), C.gray('Nonce'.padEnd(6)), C.gray('Note'));
  console.log(C.gray('-'.repeat(100)));
  for (const r of rows) {
    const src = String(r.source).padEnd(20);
    const addr = (r.address || '-').padEnd(44);
    const ok = (r.ok ? 'yes' : 'no ').padEnd(4);
    const bal = (r.balanceEth != null ? (Number(r.balanceEth).toFixed(8)) : '-').padEnd(16);
    const nnc = (r.nonce != null ? String(r.nonce) : '-').padEnd(6);
    const note = r.reason || '';
    console.log(src, addr, ok, bal, nnc, note);
  }
  console.log('');

  await computeWalletStatus(false); // refresh banner cache
  await inquirer.prompt([{ type: 'input', name: 'x', message: 'Enter untuk kembali...' }]);
}

/* ============ Save .env ============ */
async function saveEnv() {
  const lines = [];
  lines.push(`# === Network & RPC ===`);
  lines.push(`NETWORK=${state.preset}`);
  lines.push(`RPC_URL=${state.rpcUrl}`);
  lines.push(`CHAIN_ID=${state.chainId}`);
  lines.push('');
  lines.push(`# === Scan API (opsional, autodetect ABI) ===`);
  lines.push(`ETHERSCAN_API_KEY=${process.env.ETHERSCAN_API_KEY || ''}`);
  lines.push(`ARBISCAN_API_KEY=${process.env.ARBISCAN_API_KEY || ''}`);
  lines.push(`BASESCAN_API_KEY=${process.env.BASESCAN_API_KEY || ''}`);
  lines.push(`SCAN_API_KEY=${process.env.SCAN_API_KEY || ''}`);
  lines.push(`SCAN_BASEURL=${process.env.SCAN_BASEURL || ''}`);
  lines.push('');
  lines.push(`# === Generic Mint ===`);
  lines.push(`CONTRACT_ADDRESS=${state.contract}`);
  lines.push(`MINT_FUNC_SIG=${state.mintFuncSig}`);
  lines.push(`MINT_PRICE=${state.mintPrice}`);
  lines.push(`MINT_AMOUNT=${state.mintAmount}`);
  lines.push('');
  lines.push(`# === SeaDrop Public ===`);
  lines.push(`SEA_DROP_ROUTER=${state.seadroprouter}`);
  lines.push(`NFT_CONTRACT=${state.nftContractAddr || state.contract}`);
  lines.push(`FEE_RECIPIENT=${state.feeRecipient}`);
  lines.push('');
  lines.push(`# === Custom Router (opsional) ===`);
  lines.push(`CUSTOM_ROUTER=${state.customRouter}`);
  lines.push(`CUSTOM_FUNC_SIG=${state.customFuncSig}`);
  lines.push(`CUSTOM_ARGS_CSV=${state.customArgsCsv}`);
  lines.push('');
  lines.push(`# === Gas & Runtime ===`);
  lines.push(`GAS_LIMIT=${state.gasLimit}`);
  lines.push(`MAX_FEE_GWEI=${state.maxFee ?? ''}`);
  lines.push(`MAX_PRIORITY_GWEI=${state.maxPrio ?? ''}`);
  lines.push(`CONCURRENCY=${state.conc}`);
  lines.push('');
  lines.push(`# === Wallet (single mode) ===`);
  lines.push(`PRIVATE_KEY=${process.env.PRIVATE_KEY || ''}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
  console.log(C.green('\nTersimpan ke .env\n'));
}

/* ============ Runners ============ */
async function runAutoSingle() {
  if (!state.contract) return console.log(C.red('Set contract dulu.'));
  const provider = await getProvider();
  const pk = (process.env.PRIVATE_KEY || '').trim();
  if (!pk) return console.log(C.red('PRIVATE_KEY kosong di .env'));
  const wallet = new ethers.Wallet(pk, provider);

  const detected = await detectMintFunction(wallet);
  if (!detected) return;
  const spinner = makeSpinner('Broadcast single (AUTO)...').start();
  const startAt = Date.now();
  try {
    const rec = await mintGenericDetected_single(wallet, detected);
    spinner.succeed(`Mined in block ${rec.blockNumber}`);
    logActivity({ type: 'auto_single', ok: true, block: rec.blockNumber, from: wallet.address, ms: Date.now()-startAt });
  } catch (e) {
    spinner.fail((e.message || '').split('\n')[0]);
    logActivity({ type: 'auto_single', ok: false, error: (e.message||'') });
  }
}

async function runAutoMulti() {
  if (!state.contract) return console.log(C.red('Set contract dulu.'));
  const provider = await getProvider();

  let pk = (process.env.PRIVATE_KEY || '').trim();
  if (!pk) {
    const keys = loadWalletKeys(); if (keys.length === 0) return console.log(C.red('wallets.txt kosong & PRIVATE_KEY tidak ada'));
    pk = keys[0];
  }
  const tmpWallet = new ethers.Wallet(pk, provider);
  const detected = await detectMintFunction(tmpWallet);
  if (!detected) return;

  await runWithWallets(async (wallet) => mintGenericDetected_single(wallet, detected), 'AUTO mint (detected ABI)');
}

async function runSeaDropSingle() {
  if (!state.contract && !state.nftContractAddr) return console.log(C.red('Set NFT contract dulu.'));
  const provider = await getProvider();
  const pk = (process.env.PRIVATE_KEY || '').trim();
  if (!pk) return console.log(C.red('PRIVATE_KEY kosong di .env'));
  const wallet = new ethers.Wallet(pk, provider);

  // default router/fee bila kosong
  if (!state.seadroprouter) state.seadroprouter = PRESETS[state.preset]?.seadroprouter || state.seadroprouter;
  if (!state.feeRecipient) state.feeRecipient = PRESETS[state.preset]?.defaultFeeRecipient || state.feeRecipient;

  const a = await inquirer.prompt([
    { name: 'router', message: 'SeaDrop Router:', default: state.seadroprouter },
    { name: 'fee', message: 'Fee Recipient:', default: state.feeRecipient }
  ]);
  state.seadroprouter = a.router.trim();
  state.feeRecipient = a.fee.trim();

  console.log(C.gray('\n[SeaDrop] Summary:'));
  console.log('  NFT   :', state.nftContractAddr || state.contract);
  console.log('  Router:', state.seadroprouter);
  console.log('  Fee   :', state.feeRecipient);
  console.log('  Qty   :', state.mintAmount, '  Price:', String(state.mintPrice), '\n');

  const spinner = makeSpinner('Broadcast single SeaDrop...').start();
  const startAt = Date.now();
  try {
    const rec = await mintSeaDropPublic_single(wallet);
    spinner.succeed(`Mined in block ${rec.blockNumber}`);
    logActivity({ type: 'seadrop_single', ok: true, block: rec.blockNumber, from: wallet.address, ms: Date.now()-startAt });
  } catch (e) {
    spinner.fail((e.message || '').split('\n')[0]);
    logActivity({ type: 'seadrop_single', ok: false, error: (e.message||'') });
    await inquirer.prompt([{ type: 'input', name: 'x', message: 'Enter untuk kembali...' }]); // pause
  }
}

async function runSeaDropMulti() {
  if (!state.contract && !state.nftContractAddr) return console.log(C.red('Set NFT contract dulu.'));
  if (!state.seadroprouter) state.seadroprouter = PRESETS[state.preset]?.seadroprouter || state.seadroprouter;
  if (!state.feeRecipient) state.feeRecipient = PRESETS[state.preset]?.defaultFeeRecipient || state.feeRecipient;

  const a = await inquirer.prompt([
    { name: 'router', message: 'SeaDrop Router:', default: state.seadroprouter },
    { name: 'fee', message: 'Fee Recipient:', default: state.feeRecipient }
  ]);
  state.seadroprouter = a.router.trim();
  state.feeRecipient = a.fee.trim();

  await runWithWallets(async (wallet) => mintSeaDropPublic_single(wallet), 'SeaDrop Public mint');
}

async function runGenericManualSingle() {
  if (!state.contract) return console.log(C.red('Set contract dulu.'));
  const provider = await getProvider();
  const pk = (process.env.PRIVATE_KEY || '').trim();
  if (!pk) return console.log(C.red('PRIVATE_KEY kosong di .env'));
  const wallet = new ethers.Wallet(pk, provider);

  const a = await inquirer.prompt([{ name: 'sig', message: 'Function Signature:', default: state.mintFuncSig }]);
  state.mintFuncSig = a.sig.trim();

  const spinner = makeSpinner('Broadcast single (manual sig)...').start();
  const startAt = Date.now();
  try {
    const rec = await mintGenericManual_single(wallet);
    spinner.succeed(`Mined in block ${rec.blockNumber}`);
    logActivity({ type: 'manual_single', ok: true, block: rec.blockNumber, from: wallet.address, ms: Date.now()-startAt });
  } catch (e) {
    spinner.fail((e.message || '').split('\n')[0]);
    logActivity({ type: 'manual_single', ok: false, error: (e.message||'') });
  }
}

async function runGenericManualMulti() {
  if (!state.contract) return console.log(C.red('Set contract dulu.'));
  const a = await inquirer.prompt([{ name: 'sig', message: 'Function Signature:', default: state.mintFuncSig }]);
  state.mintFuncSig = a.sig.trim();

  await runWithWallets(async (wallet) => mintGenericManual_single(wallet), 'Generic manual signature');
}

/* ============ Bootstrap ============ */
(async () => {
  setPreset(state.preset);
  if (process.env.RPC_URL) state.rpcUrl = process.env.RPC_URL;
  if (state.contract) state.nftContractAddr = state.contract;
  if (!state.seadroprouter) state.seadroprouter = PRESETS[state.preset]?.seadroprouter || '';
  if (!state.feeRecipient) state.feeRecipient = PRESETS[state.preset]?.defaultFeeRecipient || '';

  await computeWalletStatus(false); // preload banner cache
  await mainMenu();
})();
