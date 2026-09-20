/**
 * zz-approve-ethcall.mjs — eth_call the attributed approve against the LIVE
 * cUSD contract on Celo Mainnet (read-only, broadcast-free) to prove the
 * encoded calldata is valid and succeeds at the contract level.
 */
import { createPublicClient, http, encodeFunctionData, erc20Abi, parseUnits, concatHex, toHex } from "viem";
import { celo } from "viem/chains";
import { Attribution } from "ox/erc8021";

const CUSD = "0x765de816845861e75a25fca122bb6898b8b1282a";
const RPC = "https://forno.celo.org";
const FROM = "0x1111111111111111111111111111111111111111"; // eth_call only; no key, no broadcast
const SPENDER = "0x3333333333333333333333333333333333333333";
const AMOUNT = parseUnits("25", 18);
const TAG = "celo_0c607ceeb1b3";

const client = createPublicClient({ chain: celo, transport: http(RPC) });

const before = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SPENDER, AMOUNT] });
const after = concatHex([before, Attribution.toDataSuffix({ codes: [TAG] })]);

async function call(label, data) {
  try {
    const res = await client.call({ account: FROM, to: CUSD, data });
    const hex = toHex(res.data);
    const ok = /^0x[0-9a-fA-F]{63}1$/.test(hex); // 32-byte ABI boolean true
    console.log(`${label}: SUCCESS  return=${hex}  (bool true: ${ok})`);
    return true;
  } catch (err) {
    console.log(`${label}: FAILED  ${String(err?.message ?? err).slice(0, 300)}`);
    return false;
  }
}

console.log("eth_call against LIVE cUSD @ Celo Mainnet (chain", await client.getChainId(), ") — read-only, never broadcast");
await call("BEFORE (pristine approve)     ", before);
await call("AFTER  (approve + erc8021 tag)", after);
