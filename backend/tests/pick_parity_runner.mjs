import { pickIndex } from "../../frontend/js/kitFromSeed.js";

const raw = process.argv[2] || "[]";
const cases = JSON.parse(raw);
const out = cases.map(([seed, slot, spice, n]) => pickIndex(seed, slot, spice, n));
console.log(JSON.stringify(out));
