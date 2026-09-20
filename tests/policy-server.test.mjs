import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import {
  buildRequest,
  parseDecision,
  validateObservation,
  POLICY_VERSION,
} from "../src/policy.mjs";
import { createAgentServer } from "../src/server.mjs";
import { modelState } from "../web/observation.js";
import { observation } from "./fixtures/land.mjs";
const criteria = buildRequest(observation()).questions.action.criteria;

const response = (action = "attack_wilderness_10") => ({
  model: "jev-test",
  usage: { input_tokens: 100, output_tokens: 20 },
  answers: {
    action: {
      type: "choice",
      choice: action,
      confidence: 0.8,
      probabilities: Object.fromEntries(
        Object.keys(criteria).map((key) => [key, key === action ? 1 : 0]),
      ),
    },
  },
});

test("request includes border/neighbor facts and exactly the legal target-size options", () => {
  const request = buildRequest(observation());
  assert.deepEqual(request.state, modelState(observation()));
  assert.deepEqual(Object.keys(request.questions), ["action"]);
  assert.deepEqual(Object.keys(request.questions.action.criteria), [
    "wait",
    "attack_wilderness_10",
    "attack_wilderness_20",
    "attack_player_2_10",
    "attack_player_2_20",
  ]);
  assert.equal(
    request.questions.action.criteria.attack_player_2_20
      .committed_to_defender_ratio,
    0.5,
  );
});

test("prompt supplies only a goal and field/action semantics, not a tactical policy or cadence", () => {
  const question = buildRequest(observation()).questions.action;
  assert.match(question.instructions.join(" "), /survive and gain territory/);
  assert.doesNotMatch(
    JSON.stringify(question),
    /30%|31\.6|35\.3|growth peak|reserve target|prefer wilderness|second|interval|poll|latency|timer/i,
  );
  assert.equal(POLICY_VERSION, "land-observation-v3");
});

test("accepts zero troops and reserves temporarily above capacity", () => {
  assert.deepEqual(validateObservation(observation(0)), observation(0));
  assert.deepEqual(validateObservation(observation(13000)), observation(13000));
});

test("rejects missing capacity, extra state, invalid counts, and unsupported actions", () => {
  for (const value of [
    null,
    [],
    {},
    { troops: 2500 },
    { troop_capacity: 12000 },
    observation(-1),
    observation(NaN),
    observation(Infinity),
    observation("2500"),
    observation(1e10),
    observation(2500, 0),
    observation(2500, -1),
    observation(2500, NaN),
    observation(2500, Infinity),
    observation(2500, "12000"),
    observation(2500, 1e10),
    { ...observation(), enemy: "extra" },
    { troops: 2, capacity: 5 },
  ]) {
    assert.throws(() => validateObservation(value));
  }
  for (const action of [
    "attack_100",
    "attack_player_3_10",
    "attack_player_99_20",
    "attack_0",
  ]) {
    assert.throws(() => parseDecision(response(action), criteria));
  }
  const bad = response();
  bad.answers.action.probabilities.attack_wilderness_10 = 2;
  assert.throws(() => parseDecision(bad, criteria));
  assert.equal(parseDecision(response("wait"), criteria).action, "wait");
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
  const reply = await post(url, observation());
  assert.equal(reply.status, 200);
  assert.equal(
    reply.headers.get("access-control-allow-origin"),
    "http://localhost:9000",
  );
  const result = await reply.json();
  assert.equal(result.action, "attack_wilderness_10");
  assert.equal(calls[0][0], "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0][1].headers.Authorization, "Bearer fake-test-secret");
  assert.deepEqual(
    JSON.parse(calls[0][1].body).state,
    modelState(observation()),
  );
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify({ result, logs }).includes("fake-test-secret"));
  assert.ok(Number.isFinite(Date.parse(logs[0].requestStartedAt)));
});

test("the sidecar paces early arrivals without 429 or overlapping inference", async (t) => {
  const starts = [];
  const url = await serve(t, {
    apiKey: "fake",
    minimumIntervalMs: 50,
    fetchImpl: async () => {
      starts.push(performance.now());
      return new Response(JSON.stringify(response()));
    },
  });
  for (let i = 0; i < 3; i++) {
    const reply = await post(url, observation());
    assert.equal(reply.status, 200);
    await reply.json();
  }
  // A small tolerance covers the measurement inside the mock vs the call site.
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i] - starts[i - 1] >= 49);
});

test("the sidecar rejects a second request while inference is outstanding", async (t) => {
  let resolveInference, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const url = await serve(t, {
    apiKey: "fake",
    fetchImpl: async () => {
      calls++;
      entered();
      return new Promise((resolve) => {
        resolveInference = resolve;
      });
    },
  });
  const first = post(url, observation());
  await started;
  assert.equal((await post(url, observation(2600))).status, 429);
  assert.equal(calls, 1);
  resolveInference(new Response(JSON.stringify(response())));
  assert.equal((await first).status, 200);
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
    (await post(url, observation(100), "https://evil.example")).status,
    403,
  );
  assert.equal(
    (await post(url, { ...observation(100), enemy: "extra" })).status,
    400,
  );
  assert.equal((await post(url, { troops: 100 })).status, 400);
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
  const reply = await post(url, observation(100));
  assert.equal(reply.status, 502);
  assert.deepEqual(await reply.json(), { error: "TypeSafe HTTP 401" });
});

test("missing key does not make a model request", async (t) => {
  const url = await serve(t, {});
  assert.equal((await post(url, observation(100))).status, 503);
  for (const path of [
    "/agent.js",
    "/controller.js",
    "/observation.js",
    "/game-adapter.js",
  ]) {
    assert.equal((await fetch(url + path)).status, 200);
  }
});
