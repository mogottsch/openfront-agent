import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import {
  buildRequest,
  parseDecision,
  ACTIONS,
  validateObservation,
} from "../src/policy.mjs";
import { createAgentServer } from "../src/server.mjs";

const response = (action = "attack_10") => ({
  model: "jev-test",
  usage: { input_tokens: 100, output_tokens: 20 },
  answers: {
    action: {
      type: "choice",
      choice: action,
      confidence: 0.8,
      probabilities: Object.fromEntries(
        Object.keys(ACTIONS).map((key) => [key, key === action ? 1 : 0]),
      ),
    },
  },
});

test("request exposes exactly one observation and the four specified choices", () => {
  const request = buildRequest({ troops: 2500 });
  assert.deepEqual(request.state, { troops: 2500 });
  assert.deepEqual(Object.keys(request.questions), ["action"]);
  assert.deepEqual(Object.keys(request.questions.action.criteria), [
    "wait",
    "attack_0",
    "attack_10",
    "attack_20",
  ]);
});

test("rejects extra state, invalid troop counts, and unsupported actions", () => {
  for (const value of [
    null,
    [],
    {},
    { troops: -1 },
    { troops: NaN },
    { troops: Infinity },
    { troops: "2500" },
    { troops: 2, capacity: 5 },
  ]) {
    assert.throws(() => validateObservation(value));
  }
  assert.throws(() => parseDecision(response("attack_100")));
  const bad = response();
  bad.answers.action.probabilities.attack_10 = 2;
  assert.throws(() => parseDecision(bad));
  assert.equal(parseDecision(response("attack_0")).action, "attack_0");
});

async function serve(t, options) {
  const server = createAgentServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (url, body, origin = "http://localhost:9000") =>
  fetch(url + "/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });

test("HTTP bridge authenticates upstream only and logs the actual request/answer", async (t) => {
  const calls = [],
    logs = [];
  const url = await serve(t, {
    apiKey: "fake-test-secret",
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify(response()));
    },
    log: async (record) => logs.push(record),
  });
  const reply = await post(url, { troops: 2500 });
  assert.equal(reply.status, 200);
  assert.equal(
    reply.headers.get("access-control-allow-origin"),
    "http://localhost:9000",
  );
  const result = await reply.json();
  assert.equal(result.action, "attack_10");
  assert.equal(calls[0][0], "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0][1].headers.Authorization, "Bearer fake-test-secret");
  assert.deepEqual(JSON.parse(calls[0][1].body).state, { troops: 2500 });
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify({ result, logs }).includes("fake-test-secret"));
  assert.equal((await post(url, { troops: 2500 })).status, 429);
});

test("rejects foreign origins, malformed observations, and untrusted hosts before inference", async (t) => {
  let calls = 0;
  const url = await serve(t, {
    apiKey: "fake",
    fetchImpl: async () => {
      calls++;
    },
  });
  assert.equal(
    (await post(url, { troops: 100 }, "https://evil.example")).status,
    403,
  );
  assert.equal((await post(url, { troops: 100, enemy: "extra" })).status, 400);
  const hostStatus = await new Promise((resolve, reject) => {
    get(url + "/health", { headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal(calls, 0);
});

test("upstream errors are bounded and contain no upstream body or key", async (t) => {
  const url = await serve(t, {
    apiKey: "fake-secret",
    fetchImpl: async () => new Response("fake-secret", { status: 401 }),
  });
  const reply = await post(url, { troops: 100 });
  assert.equal(reply.status, 502);
  assert.deepEqual(await reply.json(), { error: "TypeSafe HTTP 401" });
});

test("missing key does not make a model request", async (t) => {
  const url = await serve(t, {});
  assert.equal((await post(url, { troops: 100 })).status, 503);
  assert.equal((await fetch(url + "/agent.js")).status, 200);
});
