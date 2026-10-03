import {
  fetch,
  headers,
  payloadHash,
  runSourceLoop,
  type SourceAdapter,
  type SourceResult,
} from "./_lib.ts";
import { buildEeaGridEvent, ERCOT_DAILY_PRC_URL, parseEeaState } from "./grid_events.ts";

const SOURCE_ID = "ercot_eea";

export async function parseEeaPayload(
  value: unknown,
  retrievedAt = Math.floor(Date.now() / 1_000),
): Promise<SourceResult> {
  const state = parseEeaState(value);
  const semanticState = {
    condition_note: state.condition_note,
    eea_level: state.eea_level,
    state: state.state,
    title: state.title,
  };
  return {
    dataTimestamp: state.source_epoch,
    diagnostics: {
      evidence_class: state.evidence_class,
      time_basis: state.time_basis,
      transition_time_is_official_declaration: false,
    },
    events: [],
    gridEvents: [await buildEeaGridEvent(state, retrievedAt)],
    gridEventStream: "eea",
    metrics: [
      {
        interval: 600,
        metric_name: "ercot.eea_level",
        metric_type: "gauge",
        points: [
          {
            dedupe_key: `${SOURCE_ID}:ercot.eea_level:${state.source_epoch}`,
            timestamp: state.source_epoch,
            value: state.eea_level,
          },
        ],
      },
    ],
    payloadHash: await payloadHash(semanticState),
    provenance: {
      condition_note: state.condition_note,
      source_epoch: state.source_epoch,
      source_url: state.source_url,
      state: state.state,
      title: state.title,
    },
    sourceTimestamp: state.source_epoch,
  };
}

async function gather() {
  const retrievedAt = Math.floor(Date.now() / 1_000);
  const body = await fetch(ERCOT_DAILY_PRC_URL, headers("application/json")).then((response) =>
    response.json(),
  );
  return parseEeaPayload(body, retrievedAt);
}

export const adapter: SourceAdapter = {
  sourceId: SOURCE_ID,
  displayName: "ERCOT EEA daily PRC state",
  expectedIntervalSeconds: 600,
  publicationMode: "polling",
  gather,
};

export async function start() {
  await runSourceLoop(adapter);
}

if (import.meta.main) await start();
