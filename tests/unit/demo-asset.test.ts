import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// E-03: the README demo must degrade to the complete static transcript
// wherever CSS animation does not run (Firefox <img>, previews, social
// cards). That property lives in the asset's stylesheet, so it is pinned
// here like any other behavior.
const svg = readFileSync(join(import.meta.dirname, "..", "..", "assets", "demo.svg"), "utf8");

test("demo.svg static render: base group opacity is 1, so a no-animation viewer sees everything", () => {
  const base = /\.g\s*\{([^}]*)\}/.exec(svg);
  assert.ok(base, "the shared .g rule exists");
  assert.match(base![1]!, /opacity:\s*1/);
  assert.doesNotMatch(base![1]!, /opacity:\s*0/);
});

test("demo.svg groups: all twelve transcript groups present, each with keyframes", () => {
  for (let i = 1; i <= 12; i++) {
    assert.ok(svg.includes(`class="g g${i}"`), `group g${i} present`);
    assert.ok(new RegExp(`@keyframes k${i}\\b`).test(svg), `keyframes k${i} present`);
  }
});

test("demo.svg animation: every group holds the final frame (ends at opacity 1, never fades out)", () => {
  const frames = [...svg.matchAll(/@keyframes\s+k\d+\s*\{([^}]*(?:\}[^}]*)*?)\}\s*$/gm)];
  const blocks = [...svg.matchAll(/@keyframes\s+k\d+\s*\{(.*)\}/g)];
  assert.equal(blocks.length, 12);
  for (const m of blocks) {
    const body = m[1]!;
    const last = /100%\s*\{\s*opacity:\s*([01])\s*\}\s*$/.exec(body.trim());
    assert.ok(last, `keyframes end with an explicit 100% frame: ${body}`);
    assert.equal(last![1], "1", `final frame holds at opacity 1: ${body}`);
  }
  void frames;
});

test("demo.svg payoff: the pitch groups are visible from 0s (cold open) and across the loop boundary", () => {
  for (const k of ["k8", "k9"]) {
    const m = new RegExp(`@keyframes\\s+${k}\\s*\\{(.*)\\}`).exec(svg);
    assert.ok(m, `${k} present`);
    assert.match(m![1]!, /^\s*0%\s*\{\s*opacity:\s*1\s*\}/, `${k} starts visible`);
  }
});

test("demo.svg stays pure SVG/CSS: no scripts, no external requests", () => {
  assert.doesNotMatch(svg, /<script/i);
  // The xmlns namespace identifier is not a request; anything else isn't ok.
  const withoutXmlns = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
  assert.doesNotMatch(withoutXmlns, /https?:\/\//);
  assert.doesNotMatch(withoutXmlns, /url\(/i);
});
