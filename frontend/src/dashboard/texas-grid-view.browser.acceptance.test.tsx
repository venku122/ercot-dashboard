// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TexasGridView } from "./TexasGridView";
import {
  texasGridGisFixture,
  texasGridManifestFixture,
  texasGridTrendFixture,
} from "./texas-grid-long-horizon-acceptance.test";
import {
  parseTexasGridResource,
  type TexasGridResource,
  type TexasGridSelectedResource,
} from "./texas-grid-long-horizon";

const mocks = vi.hoisted(() => ({
  loadTexasGridManifest: vi.fn(),
  loadTexasGridResource: vi.fn(),
}));
let revalidateManifest: (() => Promise<unknown>) | null = null;
let revalidateResource: ((url: string) => Promise<unknown>) | null = null;

function RevalidationBridge() {
  const { mutate } = useSWRConfig();
  revalidateManifest = () => mutate(["texas-grid", "manifest"]);
  revalidateResource = (url) => mutate(["texas-grid", "resource", url]);
  return null;
}

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  loadTexasGridManifest: mocks.loadTexasGridManifest,
  loadTexasGridResource: mocks.loadTexasGridResource,
}));

function resourceFor(selected: TexasGridSelectedResource): TexasGridResource {
  return parseTexasGridResource(
    selected.url.includes("/gis/") ? texasGridGisFixture() : texasGridTrendFixture(),
    selected,
  );
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

describe("PR21 Texas Grid browser lifecycle acceptance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, "", "/?view=overview");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.loadTexasGridManifest.mockReset().mockResolvedValue(texasGridManifestFixture());
    mocks.loadTexasGridResource
      .mockReset()
      .mockImplementation(async (selected: TexasGridSelectedResource) => resourceFor(selected));
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
        <TexasGridView enabled={enabled} />
      </SWRConfig>,
    );
  }

  it("makes zero requests outside Texas Grid, then one manifest and selected history only", async () => {
    await act(async () => render(false));
    await flush();
    expect(mocks.loadTexasGridManifest).not.toHaveBeenCalled();
    expect(mocks.loadTexasGridResource).not.toHaveBeenCalled();

    await act(async () => render(true));
    await flush();
    expect(mocks.loadTexasGridManifest).toHaveBeenCalledTimes(1);
    expect(mocks.loadTexasGridManifest.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(mocks.loadTexasGridResource).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Long-term load forecast");
    expect(container.textContent).toContain("Unavailable: units are not authoritatively frozen");

    click(container, "Open interconnection history");
    await flush();
    expect(window.location.search).toContain("grid_resource=gis");
    expect(mocks.loadTexasGridResource).toHaveBeenCalledTimes(1);
    expect(mocks.loadTexasGridResource.mock.calls[0]![0].url).toContain("/gis/");
    expect(mocks.loadTexasGridResource.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(container.textContent).toContain("signed source capacity sums");
    expect(container.textContent).toContain("-25.5 MW");
    expect(container.textContent).toContain("not installed or committed capacity");
    expect(container.querySelectorAll(".texas-grid-table tbody tr").length).toBeGreaterThan(0);
  });

  it("aborts selected history on switch and exit without mixing stale completion", async () => {
    const signals: AbortSignal[] = [];
    const resolves: Array<(resource: TexasGridResource) => void> = [];
    const selected: TexasGridSelectedResource[] = [];
    mocks.loadTexasGridResource.mockImplementation(
      (resource: TexasGridSelectedResource, signal: AbortSignal) =>
        new Promise<TexasGridResource>((resolve) => {
          selected.push(resource);
          signals.push(signal);
          resolves.push(resolve);
        }),
    );
    await act(async () => render(true));
    await flush();
    click(container, "Open interconnection history");
    await flush();
    click(container, "Open capacity history");
    await flush();
    expect(signals[0]!.aborted).toBe(true);

    await act(async () => resolves[0]!(resourceFor(selected[0]!)));
    await flush();
    expect(container.textContent).not.toContain("Generator interconnection study aggregates");

    await act(async () => render(false));
    expect(signals[1]!.aborted).toBe(true);
  });

  it("aborts selected history on unmount", async () => {
    let signal: AbortSignal | null = null;
    mocks.loadTexasGridResource.mockImplementation(
      (_resource: TexasGridSelectedResource, nextSignal: AbortSignal) =>
        new Promise<TexasGridResource>(() => {
          signal = nextSignal;
        }),
    );
    await act(async () => render(true));
    await flush();
    click(container, "Open interconnection history");
    await flush();
    expect(signal).not.toBeNull();
    await act(async () => root.unmount());
    expect(signal!.aborted).toBe(true);
  });

  it("restores canonical resource selection through browser history", async () => {
    window.history.replaceState(null, "", "/?view=texas-grid&grid_resource=gis");
    await act(async () => render(true));
    await flush();
    expect(mocks.loadTexasGridResource).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Generator interconnection study aggregates");

    window.history.pushState(null, "", "/?view=texas-grid&grid_resource=resource_capacity_trend");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await flush();
    expect(mocks.loadTexasGridResource).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Resource capacity trend");
  });

  it("distinguishes mixed failure/stale state and labels same-key refresh failures", async () => {
    const mixed = structuredClone(texasGridManifestFixture());
    mixed.generator_interconnection.state = "stale";
    mixed.resource_capacity_trend = { state: "failed", selected: null };
    mixed.source_health[0].state = "stale";
    mixed.source_health[1].state = "failed";
    mixed.source_health[1].availability_status = "unavailable";
    mocks.loadTexasGridManifest.mockResolvedValueOnce(mixed);
    await act(async () => render(true));
    await flush();
    expect(container.textContent).toContain("staleGenerator interconnection status");
    expect(container.textContent).toContain("failedResource capacity trend");
    const capacityButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("capacity history"),
    );
    expect(capacityButton?.disabled).toBe(true);

    click(container, "Open interconnection history");
    await flush();
    const resourceUrl = mixed.generator_interconnection.selected!.url;
    expect(container.textContent).toContain("Generator interconnection study aggregates");

    mocks.loadTexasGridManifest.mockRejectedValueOnce(new Error("manifest_refresh_failed"));
    await act(async () => {
      await revalidateManifest?.();
    });
    await flush();
    expect(container.textContent).toContain(
      "Refresh failed; showing the last successful Texas Grid manifest.",
    );

    mocks.loadTexasGridResource.mockRejectedValueOnce(new Error("resource_refresh_failed"));
    await act(async () => {
      await revalidateResource?.(resourceUrl);
    });
    await flush();
    expect(container.textContent).toContain(
      "Refresh failed; showing the selected immutable history resource.",
    );
    expect(container.textContent).toContain("-25.5 MW");
  });
});
