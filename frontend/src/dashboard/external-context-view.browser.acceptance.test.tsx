// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalContextView } from "./ExternalContextView";
import {
  externalContextEgridFixture,
  externalContextManifestFixture,
} from "./external-context-acceptance.test";
import {
  parseExternalContextManifest,
  parseExternalContextResource,
  type ExternalContextManifest,
  type ExternalContextResource,
  type ExternalContextSelected,
  type ExternalContextStream,
} from "./external-context";

const mocks = vi.hoisted(() => ({
  loadExternalContextManifest: vi.fn(),
  loadExternalContextResource: vi.fn(),
}));
let revalidateManifest: (() => Promise<unknown>) | null = null;
let revalidateResource: ((stream: ExternalContextStream, url: string) => Promise<unknown>) | null =
  null;

function RevalidationBridge() {
  const { mutate } = useSWRConfig();
  revalidateManifest = () => mutate(["external-context", "manifest"]);
  revalidateResource = (stream, url) => mutate(["external-context", "resource", stream, url]);
  return null;
}

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  loadExternalContextManifest: mocks.loadExternalContextManifest,
  loadExternalContextResource: mocks.loadExternalContextResource,
}));

const manifest = (): ExternalContextManifest =>
  parseExternalContextManifest(externalContextManifestFixture());

function resourceFor(
  stream: ExternalContextStream,
  selected: ExternalContextSelected,
): ExternalContextResource {
  if (stream !== "epa_egrid") throw new Error("fixture_stream_unavailable");
  return parseExternalContextResource(externalContextEgridFixture(), stream, selected);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(container: HTMLElement, name: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  if (!button) throw new Error(`missing_button:${name}`);
  act(() => button.click());
}

describe("PR22 External Context browser lifecycle acceptance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, "", "/?view=overview");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.loadExternalContextManifest.mockReset().mockResolvedValue(manifest());
    mocks.loadExternalContextResource
      .mockReset()
      .mockImplementation(
        async (stream: ExternalContextStream, selected: ExternalContextSelected) =>
          resourceFor(stream, selected),
      );
    revalidateManifest = null;
    revalidateResource = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  function render(enabled: boolean) {
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <RevalidationBridge />
        <ExternalContextView enabled={enabled} />
      </SWRConfig>,
    );
  }

  it("makes zero requests outside the view, then one manifest and selected eGRID only", async () => {
    await act(async () => render(false));
    await flush();
    expect(mocks.loadExternalContextManifest).not.toHaveBeenCalled();
    expect(mocks.loadExternalContextResource).not.toHaveBeenCalled();

    await act(async () => render(true));
    await flush();
    expect(mocks.loadExternalContextManifest).toHaveBeenCalledTimes(1);
    expect(mocks.loadExternalContextManifest.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(mocks.loadExternalContextResource).not.toHaveBeenCalled();
    expect(container.textContent).toContain("individual EIA API key not configured");
    expect(container.textContent).toContain("This is not a zero-emissions series");
    expect(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("EIA-930 evidence"),
      )?.disabled,
    ).toBe(true);

    click(container, "Open eGRID evidence");
    await flush();
    expect(window.location.search).toContain("context_source=epa_egrid");
    expect(mocks.loadExternalContextResource).toHaveBeenCalledTimes(1);
    expect(mocks.loadExternalContextResource.mock.calls[0]![0]).toBe("epa_egrid");
    expect(mocks.loadExternalContextResource.mock.calls[0]![2]).toBeInstanceOf(AbortSignal);
    expect(container.textContent).toContain("Data year 2023 · revision 2");
    expect(container.textContent).toContain("not current or marginal emissions");
    expect(
      container.querySelectorAll('[aria-label="Exact eGRID ERCT annual rate evidence"] tbody tr'),
    ).toHaveLength(7);
  });

  it("aborts a selected resource on close and ignores its late completion", async () => {
    let resolve: ((resource: ExternalContextResource) => void) | null = null;
    let signal: AbortSignal | null = null;
    let selected: ExternalContextSelected | null = null;
    mocks.loadExternalContextResource.mockImplementation(
      (
        stream: ExternalContextStream,
        nextSelected: ExternalContextSelected,
        nextSignal: AbortSignal,
      ) =>
        new Promise<ExternalContextResource>((nextResolve) => {
          expect(stream).toBe("epa_egrid");
          resolve = nextResolve;
          signal = nextSignal;
          selected = nextSelected;
        }),
    );
    await act(async () => render(true));
    await flush();
    click(container, "Open eGRID evidence");
    await flush();
    click(container, "Close eGRID evidence");
    expect(signal).not.toBeNull();
    expect(signal!.aborted).toBe(true);
    await act(async () => resolve?.(resourceFor("epa_egrid", selected!)));
    await flush();
    expect(container.textContent).not.toContain("Exact eGRID publication identity");
  });

  it("aborts the selected resource on view exit", async () => {
    const signals: AbortSignal[] = [];
    mocks.loadExternalContextResource.mockImplementation(
      (_stream: ExternalContextStream, _selected: ExternalContextSelected, signal: AbortSignal) =>
        new Promise<ExternalContextResource>(() => signals.push(signal)),
    );
    await act(async () => render(true));
    await flush();
    click(container, "Open eGRID evidence");
    await flush();
    await act(async () => render(false));
    expect(signals[0]!.aborted).toBe(true);
  });

  it("aborts the selected resource on unmount", async () => {
    let signal: AbortSignal | null = null;
    mocks.loadExternalContextResource.mockImplementation(
      (
        _stream: ExternalContextStream,
        _selected: ExternalContextSelected,
        nextSignal: AbortSignal,
      ) =>
        new Promise<ExternalContextResource>(() => {
          signal = nextSignal;
        }),
    );
    await act(async () => render(true));
    await flush();
    click(container, "Open eGRID evidence");
    await flush();
    expect(signal).not.toBeNull();
    await act(async () => root.unmount());
    expect(signal!.aborted).toBe(true);
  });

  it("restores and closes the canonical source through browser history", async () => {
    window.history.replaceState(null, "", "/?view=external-context&context_source=epa_egrid");
    await act(async () => render(true));
    await flush();
    expect(mocks.loadExternalContextResource).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("eGRID ERCT total-output emission rates");

    window.history.pushState(null, "", "/?view=external-context");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await flush();
    expect(container.textContent).not.toContain("Exact eGRID publication identity");
  });

  it("retains explicit stale-last-good and refresh-failed states", async () => {
    const stale = manifest();
    stale.epa_egrid.freshness = "stale";
    stale.source_health[2]!.state = "stale";
    mocks.loadExternalContextManifest.mockResolvedValueOnce(stale);
    await act(async () => render(true));
    await flush();
    expect(container.textContent).toContain("Available · source is stale");
    click(container, "Open eGRID evidence");
    await flush();
    const url = stale.epa_egrid.selected!.url;

    mocks.loadExternalContextManifest.mockRejectedValueOnce(new Error("manifest_refresh_failed"));
    await act(async () => {
      await revalidateManifest?.();
    });
    await flush();
    expect(container.textContent).toContain(
      "Refresh failed; showing the last successful external-context manifest.",
    );

    mocks.loadExternalContextResource.mockRejectedValueOnce(new Error("resource_refresh_failed"));
    await act(async () => {
      await revalidateResource?.("epa_egrid", url);
    });
    await flush();
    expect(container.textContent).toContain(
      "Refresh failed; showing the selected immutable external-context resource.",
    );
    expect(container.textContent).toContain("Data year 2023 · revision 2");
  });
});
