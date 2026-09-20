/**
 * zz-before-after.mjs — display the exact approve calldata, before vs after.
 * Builds BOTH encodings with the component's own expressions and prints
 * byte-level details (prefix equality, tag position, ERC-8021 decode).
 */
import { concatHex, encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { Attribution } from "ox/erc8021";

const SPENDER = "0x3333333333333333333333333333333333333333";
const AMOUNT = parseUnits("25", 18);
const TAG = "celo_0c607ceeb1b3";
const TAG_HEX = Buffer.from(TAG, "utf8").toString("hex");

const before = encodeFunctionData({
  abi: erc20Abi,
  functionName: "approve",
  args: [SPENDER, AMOUNT],
});
const suffix = Attribution.toDataSuffix({ codes: [TAG] });
const after = concatHex([before, suffix]);

console.log("TAG              :", TAG);
console.log("TAG_ASCII_HEX    : 0x" + TAG_HEX, `(user-quoted expectation: 0x${TAG_HEX})`);
console.log("");
console.log("BEFORE calldata  :", before);
console.log("BEFORE length    :", (before.length - 2) / 2, "bytes");
console.log("");
console.log("SUFFIX (erc8021) :", suffix);
console.log("SUFFIX length    :", (suffix.length - 2) / 2, "bytes");
console.log("  starts with tag hex:", suffix.startsWith("0x" + TAG_HEX));
console.log("  ends with 0x8021 pad:", suffix.endsWith("8021"));
console.log("");
console.log("AFTER calldata   :", after);
console.log("AFTER length     :", (after.length - 2) / 2, "bytes");
console.log("  prefix === BEFORE  :", after.startsWith(before));
console.log("  contains tag hex   :", after.includes(TAG_HEX));
console.log("  ends with …318021  :", after.endsWith("318021"));
console.log("");
console.log("ox/erc8021 decode of AFTER:", JSON.stringify(Attribution.fromData(after)));
console.log("");
console.log("NOTE: the official ERC-8021 wire format places the tag hex at the");
console.log("START of the suffix and pads the tail with the 0x8021 schema —");
console.log("that is what Celoscan decodes. A raw ASCII append (calldata ending");
console.log("in the bare tag hex) would NOT decode as ERC-8021 anywhere.");