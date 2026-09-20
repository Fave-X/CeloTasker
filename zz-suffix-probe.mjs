import { Attribution } from "ox/erc8021";

const REQUIRED = "0x63656c6f5f306336303763656562316233"; // "celo_0c607ceeb1b3"
const single = Attribution.toDataSuffix({ codes: ["celo_0c607ceeb1b3"] });
const both = Attribution.toDataSuffix({ codes: ["CeloTasker", "celo_0c607ceeb1b3"] });
console.log("single-code suffix :", single);
console.log("two-code suffix    :", both);
console.log("single endsWith required:", single.endsWith(REQUIRED));
console.log("two-code endsWith required:", both.endsWith(REQUIRED));
try {
  console.log("decoded single:", JSON.stringify(Attribution.fromDataSuffix(single)));
  console.log("decoded two   :", JSON.stringify(Attribution.fromDataSuffix(both)));
} catch (err) {
  console.log("decode probe unavailable:", String(err));
}