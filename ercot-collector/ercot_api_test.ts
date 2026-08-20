import {
  ErcotApiClient,
  ErcotApiError,
  ErcotRateLimiter,
  publicReportArtifactLinks,
  publicReportHrefs,
  validateEsrResponse,
  validatePublicInventory,
} from "./ercot_api.ts";
import type { ErcotClientOptions, ErcotFetch } from "./ercot_api.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = "values differ") {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  assert(left === right, `${message}: expected ${right}, received ${left}`);
}

async function assertRejects(
  callback: () => Promise<unknown>,
  code: string,
): Promise<ErcotApiError> {
  try {
    await callback();
  } catch (error) {
    assert(error instanceof ErcotApiError, `expected ErcotApiError, received ${String(error)}`);
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    return error;
  }
  throw new Error(`expected rejection ${code}`);
}

const credentials = {
  username: "fixture@example.test",
  password: "fixture-password",
  publicSubscriptionKey: "fixture-public-key",
  esrSubscriptionKey: "fixture-esr-key",
};

const esrFields = [
  { name: "AGCExecTime", dataType: "datetime" },
  { name: "DSTFlag", dataType: "boolean" },
  { name: "AGCExecTimeUTC", dataType: "datetime" },
  { name: "systemDemand", dataType: "number" },
  { name: "ESRChargingMW", dataType: "number" },
];

type RecordedCall = { init: RequestInit; url: URL };

function testOptions(fetch: ErcotFetch, overrides: Partial<ErcotClientOptions> = {}) {
  let now = 0;
  const sleeps: number[] = [];
  return {
    client: new ErcotApiClient({
      credentials,
      fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      random: () => 0,
      tokenEndpoint: "https://auth.test/token",
      publicBaseUrl: "https://api.test/api/",
      esrBaseUrl: "https://api.test/api/",
      ...overrides,
    }),
    get now() {
      return now;
    },
    setNow(value: number) {
      now = value;
    },
    sleeps,
  };
}

function tokenResponse(accessToken = "access-token", expiresIn = 3600) {
  return Response.json({
    access_token: accessToken,
    id_token: "must-not-be-used",
    expires_in: expiresIn,
  });
}

function stalledResponse(signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

const fixture = (name: string) => new URL(`./fixtures/ercot_api/${name}`, import.meta.url);

async function jsonFixture(name: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(fixture(name)));
}

Deno.test("uses access_token, manual redirects, encoded query, and the correct subscription key", async () => {
  const calls: RecordedCall[] = [];
  const fetch: ErcotFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === "auth.test") return tokenResponse();
    if (url.pathname.endsWith("/public-reports")) {
      return Response.json({
        data: [
          {
            reportName: "fixture",
            _links: { artifacts: [{ href: "/api/artifact" }] },
          },
        ],
      });
    }
    return Response.json({ fields: esrFields, data: [] });
  };
  const { client } = testOptions(fetch);

  const inventory = await client.publicReports();
  const esr = await client.esrCharging({
    AGCExecTimeFrom: "2026-08-18 12:00:00",
    AGCExecTimeTo: "2026-08-18 12:01:00",
  });

  assert(inventory.reports.length === 1, "one public report");
  assert(esr.fields.length === 5 && esr.data.length === 0, "valid empty ESR response");
  const tokenCall = calls[0]!;
  const tokenBody = tokenCall.init.body as URLSearchParams;
  assert(tokenCall.init.redirect === "manual", "token redirect must be manual");
  assert(tokenBody.get("username") === credentials.username, "username form field");
  assert(tokenBody.get("password") === credentials.password, "password form field");
  const publicCall = calls[1]!;
  assert(publicCall.init.redirect === "manual", "API redirect must be manual");
  assert(
    new Headers(publicCall.init.headers).get("Authorization") === "Bearer access-token",
    "uses access_token",
  );
  assert(
    new Headers(publicCall.init.headers).get("Ocp-Apim-Subscription-Key") ===
      credentials.publicSubscriptionKey,
    "uses Public subscription key",
  );
  const esrCall = calls[2]!;
  assert(
    new Headers(esrCall.init.headers).get("Ocp-Apim-Subscription-Key") ===
      credentials.esrSubscriptionKey,
    "uses ESR subscription key",
  );
  assert(
    esrCall.url.searchParams.get("AGCExecTimeFrom") === "2026-08-18 12:00:00",
    "query encoded",
  );
});

Deno.test("form-encodes special credentials and rejects id_token-only or redirect auth responses", async () => {
  const specialCredentials = {
    ...credentials,
    username: "user+tag@example.test",
    password: "p@ss & plus+percent%",
  };
  let encoded = "";
  const success: ErcotFetch = async (input, init = {}) => {
    if (new URL(String(input)).hostname === "auth.test") {
      encoded = String(init.body);
      return tokenResponse();
    }
    return Response.json({ data: [] });
  };
  const client = testOptions(success, { credentials: specialCredentials }).client;
  await client.publicReports();
  const parsed = new URLSearchParams(encoded);
  assert(parsed.get("username") === specialCredentials.username, "special username round trips");
  assert(parsed.get("password") === specialCredentials.password, "special password round trips");
  assert(encoded.includes("%2B") && encoded.includes("%26"), "reserved characters encoded");

  const idOnly: ErcotFetch = async () => Response.json({ id_token: "wrong", expires_in: 3600 });
  await assertRejects(
    () => testOptions(idOnly).client.publicReports(),
    "ercot_auth_response_invalid",
  );

  let redirectMode: RequestRedirect | undefined;
  const redirected: ErcotFetch = async (_input, init = {}) => {
    redirectMode = init.redirect;
    return new Response(null, { status: 302, headers: { Location: "https://example.test/" } });
  };
  const redirectError = await assertRejects(
    () => testOptions(redirected).client.publicReports(),
    "ercot_auth_failed",
  );
  assert(redirectMode === "manual" && redirectError.status === 302, "auth redirect not followed");

  let apiRedirectMode: RequestRedirect | undefined;
  const apiRedirect: ErcotFetch = async (input, init = {}) => {
    if (new URL(String(input)).hostname === "auth.test") return tokenResponse();
    apiRedirectMode = init.redirect;
    return new Response(null, { status: 302, headers: { Location: "https://example.test/" } });
  };
  const apiRedirectError = await assertRejects(
    () => testOptions(apiRedirect).client.publicReports(),
    "ercot_http_302",
  );
  assert(
    apiRedirectMode === "manual" && apiRedirectError.status === 302,
    "API redirect not followed",
  );
});

Deno.test("coalesces concurrent token acquisition and refreshes before expiry", async () => {
  let now = 0;
  let tokenCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetch: ErcotFetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "auth.test") {
      tokenCalls++;
      if (tokenCalls === 1) await gate;
      return tokenResponse(`access-${tokenCalls}`, 120);
    }
    return Response.json({ data: [] });
  };
  const client = new ErcotApiClient({
    credentials,
    fetch,
    now: () => now,
    sleep: async () => {},
    random: () => 0,
    tokenEndpoint: "https://auth.test/token",
    publicBaseUrl: "https://api.test/api/",
    esrBaseUrl: "https://api.test/api/",
  });
  const first = client.publicReports();
  const second = client.publicReports();
  await Promise.resolve();
  assert(tokenCalls === 1, "one in-flight acquisition");
  release();
  await Promise.all([first, second]);
  assert(tokenCalls === 1, "concurrent callers share token");
  now = 61_000;
  await client.publicReports();
  assertEquals(tokenCalls, 2, "refresh inside safety margin");
});

Deno.test("reacquires once after 401 without recursive retries", async () => {
  let tokenCalls = 0;
  let apiCalls = 0;
  const authorizations: string[] = [];
  const fetch: ErcotFetch = async (input, init = {}) => {
    if (new URL(String(input)).hostname === "auth.test") {
      return tokenResponse(`token-${++tokenCalls}`);
    }
    apiCalls++;
    authorizations.push(new Headers(init.headers).get("Authorization") ?? "");
    return apiCalls === 1 ? new Response(null, { status: 401 }) : Response.json({ data: [] });
  };
  const { client } = testOptions(fetch);
  await client.publicReports();
  assertEquals(authorizations, ["Bearer token-1", "Bearer token-2"]);
  assert(tokenCalls === 2 && apiCalls === 2, "one authentication retry");

  const alwaysUnauthorized: ErcotFetch = async (input) =>
    new URL(String(input)).hostname === "auth.test"
      ? tokenResponse()
      : new Response(null, { status: 401 });
  const failed = testOptions(alwaysUnauthorized).client;
  const error = await assertRejects(() => failed.publicReports(), "ercot_http_401");
  assert(error.status === 401, "401 status preserved");
});

Deno.test("coalesces concurrent 401 token refreshes", async () => {
  let tokenCalls = 0;
  let oldTokenCalls = 0;
  let release!: () => void;
  const bothOldRequests = new Promise<void>((resolve) => (release = resolve));
  const fetch: ErcotFetch = async (input, init = {}) => {
    if (new URL(String(input)).hostname === "auth.test") {
      return tokenResponse(`token-${++tokenCalls}`);
    }
    const authorization = new Headers(init.headers).get("Authorization");
    if (authorization === "Bearer token-1") {
      oldTokenCalls++;
      if (oldTokenCalls === 2) release();
      await bothOldRequests;
      return new Response(null, { status: 401 });
    }
    return Response.json({ data: [] });
  };
  const client = testOptions(fetch).client;
  await Promise.all([client.publicReports(), client.publicReports()]);
  assert(tokenCalls === 2, "concurrent 401s share one refresh");
  assert(oldTokenCalls === 2, "both requests exercised old token");
});

Deno.test("redacts authentication and API failure bodies", async () => {
  const authFetch: ErcotFetch = async () =>
    new Response(`password=${credentials.password}`, { status: 400 });
  const authError = await assertRejects(
    () => testOptions(authFetch).client.publicReports(),
    "ercot_auth_failed",
  );
  assert(!authError.message.includes(credentials.password), "password absent from auth error");

  const apiFetch: ErcotFetch = async (input) =>
    new URL(String(input)).hostname === "auth.test"
      ? tokenResponse()
      : new Response(`key=${credentials.publicSubscriptionKey}`, {
          status: 403,
        });
  const apiError = await assertRejects(
    () => testOptions(apiFetch).client.publicReports(),
    "ercot_http_403",
  );
  assert(
    !apiError.message.includes(credentials.publicSubscriptionKey),
    "key absent from API error",
  );
});

Deno.test("bounds auth 429, 5xx, timeout, and network retries", async () => {
  let authCalls = 0;
  const recovering: ErcotFetch = async (input) => {
    if (new URL(String(input)).hostname !== "auth.test") return Response.json({ data: [] });
    authCalls++;
    if (authCalls === 1) {
      return new Response(null, { status: 429, headers: { "Retry-After": "0.1" } });
    }
    if (authCalls === 2) return new Response(null, { status: 503 });
    return tokenResponse();
  };
  const recovered = testOptions(recovering, {
    retryBaseMs: 200,
    maximumRetryDelayMs: 1_000,
  });
  await recovered.client.publicReports();
  assert(authCalls === 3, "auth recovered after two retries");
  assert(recovered.sleeps.includes(100), "auth Retry-After honored");
  assert(recovered.sleeps.includes(400), "auth exponential backoff");

  let exhaustedCalls = 0;
  const unavailable: ErcotFetch = async () => {
    exhaustedCalls++;
    return new Response(null, { status: 503 });
  };
  const exhaustedError = await assertRejects(
    () => testOptions(unavailable, { maximumRetries: 2 }).client.publicReports(),
    "ercot_auth_failed",
  );
  assert(exhaustedCalls === 3 && exhaustedError.retryable, "auth 5xx retry bound");

  let timeoutCalls = 0;
  const timeout: ErcotFetch = async () => {
    timeoutCalls++;
    throw new DOMException("timeout", "AbortError");
  };
  await assertRejects(
    () => testOptions(timeout, { maximumRetries: 1 }).client.publicReports(),
    "ercot_auth_timeout",
  );
  assert(timeoutCalls === 2, "auth timeout retry bound");

  let networkCalls = 0;
  const network: ErcotFetch = async () => {
    networkCalls++;
    throw new Error(`secret=${credentials.password}`);
  };
  const networkError = await assertRejects(
    () => testOptions(network, { maximumRetries: 1 }).client.publicReports(),
    "ercot_auth_network_error",
  );
  assert(networkCalls === 2 && networkError.cause === undefined, "unsafe cause not attached");
});

Deno.test("timeout remains active through auth and API response-body decoding", async () => {
  const stalledAuth: ErcotFetch = async (_input, init = {}) =>
    stalledResponse(init.signal ?? undefined);
  await assertRejects(
    () => testOptions(stalledAuth, { timeoutMs: 5, maximumRetries: 0 }).client.publicReports(),
    "ercot_auth_timeout",
  );

  const stalledApi: ErcotFetch = async (input, init = {}) =>
    new URL(String(input)).hostname === "auth.test"
      ? tokenResponse()
      : stalledResponse(init.signal ?? undefined);
  await assertRejects(
    () => testOptions(stalledApi, { timeoutMs: 5, maximumRetries: 0 }).client.publicReports(),
    "ercot_request_timeout",
  );
});

Deno.test("bounds 429 and 5xx retries with deterministic exponential delays", async () => {
  let apiCalls = 0;
  const fetch: ErcotFetch = async (input) => {
    if (new URL(String(input)).hostname === "auth.test") return tokenResponse();
    apiCalls++;
    if (apiCalls === 1) {
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "0.1" },
      });
    }
    if (apiCalls === 2) return new Response(null, { status: 503 });
    return Response.json({ data: [] });
  };
  const harness = testOptions(fetch, {
    retryBaseMs: 200,
    maximumRetryDelayMs: 1_000,
  });
  await harness.client.publicReports();
  assert(apiCalls === 3, "two bounded retries");
  assert(harness.sleeps.includes(100), "Retry-After honored");
  assert(harness.sleeps.includes(400), "exponential retry delay");

  const unavailable: ErcotFetch = async (input) =>
    new URL(String(input)).hostname === "auth.test"
      ? tokenResponse()
      : new Response(null, { status: 500 });
  const failed = testOptions(unavailable, { maximumRetries: 2 }).client;
  const error = await assertRejects(() => failed.publicReports(), "ercot_http_500");
  assert(error.retryable, "5xx remains marked retryable");
});

Deno.test("classifies timeout/network failure after bounded retries", async () => {
  let apiCalls = 0;
  const fetch: ErcotFetch = async (input) => {
    if (new URL(String(input)).hostname === "auth.test") return tokenResponse();
    apiCalls++;
    throw new DOMException("timed out", "AbortError");
  };
  const client = testOptions(fetch, { maximumRetries: 1 }).client;
  const error = await assertRejects(() => client.publicReports(), "ercot_request_timeout");
  assert(error.retryable && apiCalls === 2, "timeout retried once");
});

Deno.test("artifact requests use advertised _links and deterministic query encoding", async () => {
  const urls: URL[] = [];
  const report = {
    artifacts: [
      {
        _links: {
          endpoint: {
            href: "https://api.test/api/reports/NP3-565?existing=yes",
          },
          archive: { href: "/archive/not-authorized" },
        },
      },
      {
        _links: { endpoint: { href: "/api/reports/NP3-565/data" } },
      },
    ],
    _links: {
      self: { href: "/api/reports/NP3-565" },
      metadata: { href: "/api/reports/NP3-565/meta" },
    },
  };
  const fetch: ErcotFetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "auth.test") return tokenResponse();
    urls.push(url);
    return Response.json({ data: [] });
  };
  const { client } = testOptions(fetch);
  assertEquals(publicReportArtifactLinks(report), [
    "https://api.test/api/reports/NP3-565?existing=yes",
    "/api/reports/NP3-565/data",
  ]);
  assert(
    publicReportArtifactLinks(report).length === report.artifacts.length,
    "one endpoint per artifact",
  );
  assert(
    publicReportHrefs(report).includes("/api/reports/NP3-565/meta"),
    "all-link helper remains distinct",
  );
  await client.publicArtifact(report, publicReportArtifactLinks(report)[0]!, {
    z: [2, 1],
    from: new Date("2026-08-18T00:00:00Z"),
    omitted: undefined,
  });
  assert(
    urls[0]!.search === "?existing=yes&from=2026-08-18T00%3A00%3A00.000Z&z=2&z=1",
    "stable query",
  );
  await assertRejects(
    () => client.publicArtifact(report, "/api/reports/NP3-565/meta"),
    "ercot_public_artifact_link_not_advertised",
  );
  const external = {
    artifacts: [{ _links: { endpoint: { href: "https://evil.test/steal" } } }],
  };
  await assertRejects(
    () => client.publicArtifact(external, "https://evil.test/steal"),
    "ercot_cross_origin_url_rejected",
  );

  await client.publicArtifact(report, "/api/reports/NP3-565/data");
  assert(
    urls[1]!.pathname === "/api/reports/NP3-565/data",
    "root-relative href does not duplicate /api",
  );

  for (const href of ["/api/../admin", "/apiary/escape"]) {
    const escaped = { artifacts: [{ _links: { endpoint: { href } } }] };
    await assertRejects(() => client.publicArtifact(escaped, href), "ercot_api_namespace_rejected");
  }
  try {
    publicReportArtifactLinks({ artifacts: [{ _links: { self: { href: "/api/self" } } }] });
    throw new Error("expected malformed artifact rejection");
  } catch (error) {
    assert(
      error instanceof ErcotApiError && error.code === "ercot_public_artifact_schema_invalid",
      "artifact without endpoint is rejected",
    );
  }
});

Deno.test("validates the live Public _embedded.products envelope and valid empty ESR data", async () => {
  const liveShape = validatePublicInventory(await jsonFixture("public_reports.valid.json"));
  assert(liveShape.reports.length === 1, "live Public envelope product");
  assert(
    publicReportArtifactLinks(liveShape.reports[0]!).some((href) => href.includes("actual_loads")),
    "live artifact link",
  );
  assert(validatePublicInventory([]).reports.length === 0, "empty inventory is structurally valid");
  assert(validatePublicInventory({ reports: [{}] }).reports.length === 1, "reports envelope");
  const validEmptyEsr = validateEsrResponse(await jsonFixture("esr.valid_empty.json"));
  assert(
    validEmptyEsr.fields.length === 5 && validEmptyEsr.data.length === 0,
    "empty ESR rows valid",
  );

  for (const invalid of [{}, { data: {} }, { data: [1] }]) {
    try {
      validatePublicInventory(invalid);
      throw new Error("expected invalid Public schema");
    } catch (error) {
      assert(error instanceof ErcotApiError, "structured Public schema error");
    }
  }
  for (const invalid of [
    {},
    { fields: [], data: {} },
    { fields: [], data: [] },
    { fields: [{}], data: [] },
    { fields: [{ name: "", dataType: "string" }], data: [] },
    { fields: [{ name: "a", dataType: "" }], data: [] },
    { fields: [{ name: "a", dataType: "string" }], data: [[1, 2]] },
    { fields: [{ name: "a", dataType: "string" }], data: [{}] },
    { fields: [{ name: "a", dataType: "string" }], data: [{ other: 1 }] },
    { fields: [{ name: "a", dataType: "string" }], data: [1] },
    { fields: esrFields, data: [], _meta: [] },
  ]) {
    try {
      validateEsrResponse(invalid);
      throw new Error("expected invalid ESR schema");
    } catch (error) {
      assert(error instanceof ErcotApiError, "structured ESR schema error");
    }
  }
  assert(
    validateEsrResponse({ fields: esrFields, data: [[1, 2, 3, 4, 5]] }).data.length === 1,
    "array row width",
  );
  assert(
    validateEsrResponse({
      fields: esrFields,
      data: [
        {
          AGCExecTime: "now",
          DSTFlag: false,
          AGCExecTimeUTC: "now",
          systemDemand: 1,
          ESRChargingMW: 2,
        },
      ],
    }).data.length === 1,
    "object row keys",
  );
});

Deno.test("rejects malformed JSON and missing ESR bounds", async () => {
  const fetch: ErcotFetch = async (input) =>
    new URL(String(input)).hostname === "auth.test"
      ? tokenResponse()
      : new Response("not-json", { status: 200 });
  const client = testOptions(fetch).client;
  await assertRejects(() => client.publicReports(), "ercot_response_json_invalid");
  await assertRejects(
    () => client.esrCharging({ AGCExecTimeFrom: "", AGCExecTimeTo: "now" }),
    "ercot_esr_bounds_required",
  );
});

Deno.test("central limiter spaces all reservations at no more than 30 per minute", async () => {
  let now = 10_000;
  const waits: number[] = [];
  const limiter = new ErcotRateLimiter(
    30,
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  );
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  assertEquals(waits, [2_000, 2_000]);
});

Deno.test("central limiter reserves concurrent and retry requests", async () => {
  const concurrentWaits: number[] = [];
  const limiter = new ErcotRateLimiter(
    30,
    () => 0,
    async (milliseconds) => {
      concurrentWaits.push(milliseconds);
    },
  );
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assertEquals(concurrentWaits, [2_000, 4_000], "concurrent reservations are serialized in time");

  let currentTime = () => 0;
  const callTimes: number[] = [];
  let apiCalls = 0;
  const fetch: ErcotFetch = async (input) => {
    if (new URL(String(input)).hostname === "auth.test") return tokenResponse();
    callTimes.push(currentTime());
    apiCalls++;
    return apiCalls === 1 ? new Response(null, { status: 503 }) : Response.json({ data: [] });
  };
  const harness = testOptions(fetch, { retryBaseMs: 100, maximumRetryDelayMs: 1_000 });
  currentTime = () => harness.now;
  await harness.client.publicReports();
  assertEquals(callTimes, [0, 2_000], "retry passes through central limiter");
});

Deno.test("validates numeric options and secure URL schemes", () => {
  const fetch: ErcotFetch = async () => tokenResponse();
  const invalidOptions: Array<[Partial<ErcotClientOptions>, string]> = [
    [{ timeoutMs: 0 }, "ercot_invalid_timeout"],
    [{ timeoutMs: 1.5 }, "ercot_invalid_timeout"],
    [{ maximumRetries: -1 }, "ercot_invalid_maximum_retries"],
    [{ maximumRetries: 11 }, "ercot_invalid_maximum_retries"],
    [{ retryBaseMs: 0 }, "ercot_invalid_retry_base"],
    [{ retryBaseMs: 500, maximumRetryDelayMs: 100 }, "ercot_invalid_maximum_retry_delay"],
    [{ tokenSafetyMarginMs: -1 }, "ercot_invalid_token_safety_margin"],
    [{ requestsPerMinute: 31 }, "ercot_invalid_rate_limit"],
    [{ publicBaseUrl: "http://api.test/api/" }, "ercot_invalid_base_url"],
    [{ publicBaseUrl: "ftp://localhost/api/" }, "ercot_invalid_base_url"],
    [{ tokenEndpoint: "http://auth.test/token" }, "ercot_invalid_token_endpoint"],
    [{ tokenEndpoint: "ftp://localhost/token" }, "ercot_invalid_token_endpoint"],
  ];
  for (const [override, code] of invalidOptions) {
    try {
      testOptions(fetch, override);
      throw new Error(`expected ${code}`);
    } catch (error) {
      assert(error instanceof ErcotApiError && error.code === code, `constructor ${code}`);
    }
  }

  const localhost = testOptions(fetch, {
    publicBaseUrl: "http://localhost:8000/api/",
    esrBaseUrl: "http://127.0.0.1:8001/api/",
    tokenEndpoint: "http://localhost:8002/token",
  });
  assert(localhost.client instanceof ErcotApiClient, "localhost HTTP is allowed for tests");
});
