import { ErcotApiError, publicReportArtifactLinks, validatePublicInventory } from "./ercot_api.ts";

type JsonObject = Record<string, unknown>;

export type ErcotCatalogArtifact = {
  artifactName: string;
  emilId: string;
  endpointHref: string;
  endpointPath: string;
  productName: string;
  productStatus: string;
  verifiedAt: string;
};

export type ErcotCatalog = {
  artifacts: ErcotCatalogArtifact[];
  productCount: number;
  products: JsonObject[];
  verifiedAt: string;
};

export type OpenApiArtifact = ErcotCatalogArtifact & {
  methods: string[];
  openApiPath: string;
  queryParameters: string[];
};

export type OpenApiReconciliation = {
  matched: OpenApiArtifact[];
  specOnlyPaths: string[];
  liveOnly: ErcotCatalogArtifact[];
};

export type PaginationResult<T> = {
  hrefs: string[];
  items: T[];
  pages: number;
};

export type SourceProvenance = {
  artifactPath: string;
  emilId: string;
  endpointHref: string;
  sourceId: string;
  sourceName: string;
  sourcePublicationTimestamp?: number;
  verifiedAt: string;
};

export type ParityDiagnostics = {
  aligned: number;
  apiRows: number;
  matched: number;
  maximumAbsoluteDelta: number | null;
  meanAbsoluteDelta: number | null;
  mismatches: Array<{
    api?: unknown;
    key: string;
    reason: "missing_api" | "missing_reference" | "unit" | "value";
    reference?: unknown;
  }>;
  missingApi: number;
  missingReference: number;
  referenceRows: number;
  truncated: boolean;
  unitMismatches: number;
  valueComparisons: number;
  valueMismatches: number;
};

export type StorageCostEstimate = {
  bytesPerDayWithIndexes: number;
  bytesPerYearWithIndexes: number;
  rawBytesPerDay: number;
  retainedBytesWithIndexes: number;
  retainedRows: number;
  rowsPerDay: number;
  thirtyDayBytesWithIndexes: number;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ErcotApiError(code);
  }
  return value;
}

function validDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new ErcotApiError("ercot_catalog_verification_date_invalid");
  }
  return value;
}

function normalizeApiBase(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ErcotApiError("ercot_catalog_base_url_invalid");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ErcotApiError("ercot_catalog_base_url_invalid");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ErcotApiError("ercot_catalog_base_url_invalid");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function apiUrl(href: string, base: URL): URL {
  let url: URL;
  try {
    url = href.startsWith("/") ? new URL(href, base.origin) : new URL(href, base);
  } catch {
    throw new ErcotApiError("ercot_catalog_endpoint_invalid");
  }
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (
    url.origin !== base.origin ||
    !(url.pathname === basePath.slice(0, -1) || url.pathname.startsWith(basePath))
  ) {
    throw new ErcotApiError("ercot_catalog_endpoint_outside_api");
  }
  url.hash = "";
  return url;
}

export function parseErcotProductCatalog(
  inventory: unknown,
  options: { apiBaseUrl?: string; verifiedAt: string },
): ErcotCatalog {
  const verifiedAt = validDate(options.verifiedAt);
  const base = normalizeApiBase(options.apiBaseUrl ?? "https://api.ercot.com/api/");
  const products = validatePublicInventory(inventory).reports;
  const artifacts: ErcotCatalogArtifact[] = [];

  for (const product of products) {
    const emilId = requiredString(product.emilId, "ercot_catalog_emil_id_invalid");
    const productName = requiredString(
      product.name ?? product.reportName,
      "ercot_catalog_product_name_invalid",
    );
    const productStatus = requiredString(product.status, "ercot_catalog_product_status_invalid");
    if (!Array.isArray(product.artifacts)) {
      throw new ErcotApiError("ercot_catalog_artifacts_invalid");
    }
    const endpointHrefs = publicReportArtifactLinks(product);
    if (endpointHrefs.length !== product.artifacts.length) {
      throw new ErcotApiError("ercot_catalog_artifacts_invalid");
    }
    product.artifacts.forEach((rawArtifact, index) => {
      if (!isObject(rawArtifact)) throw new ErcotApiError("ercot_catalog_artifacts_invalid");
      const artifactName = requiredString(
        rawArtifact.displayName ??
          rawArtifact.name ??
          rawArtifact.reportName ??
          rawArtifact.artifactName,
        "ercot_catalog_artifact_name_invalid",
      );
      const endpointHref = endpointHrefs[index]!;
      const endpoint = apiUrl(endpointHref, base);
      artifacts.push({
        artifactName,
        emilId,
        endpointHref,
        endpointPath: endpoint.pathname,
        productName,
        productStatus,
        verifiedAt,
      });
    });
  }

  return { artifacts, productCount: products.length, products, verifiedAt };
}

function pageItems<T>(page: unknown): T[] {
  if (!isObject(page) || !Array.isArray(page.data)) {
    throw new ErcotApiError("ercot_pagination_page_invalid");
  }
  return page.data as T[];
}

type PaginationMetadataState = {
  indexBase: 0 | 1 | null;
  lastPage: number | null;
  pageSize: number | null;
  totalPages: number | null;
  totalRecords: number | null;
};

function optionalMetadataInteger(value: unknown, minimum: number): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new ErcotApiError("ercot_pagination_metadata_invalid");
  }
  return value as number;
}

function nextHref(
  page: unknown,
  currentUrl: URL,
  state: PaginationMetadataState,
  pageItemCount: number,
  observedItems: number,
): string | null {
  if (!isObject(page)) throw new ErcotApiError("ercot_pagination_page_invalid");
  let advertisedNext: string | null = null;
  if (page._links !== undefined) {
    if (!isObject(page._links)) throw new ErcotApiError("ercot_pagination_next_invalid");
    if (page._links.next !== undefined && page._links.next !== null) {
      const next = page._links.next;
      if (!isObject(next) || typeof next.href !== "string" || !next.href) {
        throw new ErcotApiError("ercot_pagination_next_invalid");
      }
      advertisedNext = next.href;
    }
  }
  if (page._meta === undefined) return advertisedNext;
  if (!isObject(page._meta)) throw new ErcotApiError("ercot_pagination_metadata_invalid");
  const currentPage = optionalMetadataInteger(page._meta.currentPage, 0);
  const totalPages = optionalMetadataInteger(page._meta.totalPages, 0);
  const totalRecords = optionalMetadataInteger(page._meta.totalRecords, 0);
  const pageSize = optionalMetadataInteger(page._meta.pageSize, 1);
  if (currentPage === null && totalPages === null) return advertisedNext;
  if (currentPage === null || totalPages === null) {
    throw new ErcotApiError("ercot_pagination_metadata_invalid");
  }
  state.indexBase ??= currentPage === 0 ? 0 : 1;
  const minimumPage = state.indexBase;
  const maximumPage = state.indexBase === 0 ? Math.max(0, totalPages - 1) : totalPages;
  if (
    currentPage < minimumPage ||
    currentPage > maximumPage ||
    (state.lastPage !== null && currentPage !== state.lastPage + 1) ||
    (state.totalPages !== null && totalPages !== state.totalPages) ||
    (state.totalRecords !== null && totalRecords !== null && totalRecords !== state.totalRecords) ||
    (state.pageSize !== null && pageSize !== null && pageSize !== state.pageSize)
  ) {
    throw new ErcotApiError("ercot_pagination_metadata_inconsistent");
  }
  state.lastPage = currentPage;
  state.totalPages ??= totalPages;
  state.totalRecords ??= totalRecords;
  state.pageSize ??= pageSize;
  const hasNext = currentPage < maximumPage;
  if (hasNext && pageItemCount === 0) {
    throw new ErcotApiError("ercot_pagination_unexpected_empty_page");
  }
  if (!hasNext) {
    if (advertisedNext !== null) {
      throw new ErcotApiError("ercot_pagination_metadata_inconsistent");
    }
    if (state.totalRecords !== null && observedItems !== state.totalRecords) {
      throw new ErcotApiError("ercot_pagination_metadata_inconsistent");
    }
    return null;
  }
  if (advertisedNext !== null) return advertisedNext;
  const next = new URL(currentUrl);
  next.searchParams.set("page", String(currentPage + 1));
  return next.toString();
}

export async function collectErcotPages<T>(
  initialHref: string,
  fetchPage: (url: URL) => Promise<unknown>,
  options: {
    apiBaseUrl?: string;
    maxItems?: number;
    maxPages?: number;
    readItems?: (page: unknown) => T[];
    readNextHref?: (page: unknown) => string | null;
  } = {},
): Promise<PaginationResult<T>> {
  const base = normalizeApiBase(options.apiBaseUrl ?? "https://api.ercot.com/api/");
  const maxPages = options.maxPages ?? 100;
  const maxItems = options.maxItems ?? 1_000;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    throw new ErcotApiError("ercot_pagination_page_limit_invalid");
  }
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1_000_000) {
    throw new ErcotApiError("ercot_pagination_item_limit_invalid");
  }
  const readItems = options.readItems ?? pageItems<T>;
  const readNext = options.readNextHref;
  const seen = new Set<string>();
  const metadataState: PaginationMetadataState = {
    indexBase: null,
    lastPage: null,
    pageSize: null,
    totalPages: null,
    totalRecords: null,
  };
  const hrefs: string[] = [];
  const items: T[] = [];
  let href: string | null = initialHref;

  while (href !== null) {
    if (hrefs.length >= maxPages) throw new ErcotApiError("ercot_pagination_page_limit_exceeded");
    const url = apiUrl(href, base);
    const canonical = url.toString();
    if (seen.has(canonical)) throw new ErcotApiError("ercot_pagination_cycle");
    seen.add(canonical);
    hrefs.push(canonical);
    const page = await fetchPage(url);
    const nextItems = readItems(page);
    if (!Array.isArray(nextItems)) throw new ErcotApiError("ercot_pagination_page_invalid");
    if (items.length + nextItems.length > maxItems) {
      throw new ErcotApiError("ercot_pagination_item_limit_exceeded");
    }
    items.push(...nextItems);
    href = readNext
      ? readNext(page)
      : nextHref(page, url, metadataState, nextItems.length, items.length);
  }
  return { hrefs, items, pages: hrefs.length };
}

export function encodeErcotQuery(
  values: Record<
    string,
    string | number | boolean | Array<string | number | boolean> | null | undefined
  >,
  allowedFields: readonly string[],
  maximumValues = 100,
): string {
  if (!Number.isInteger(maximumValues) || maximumValues < 1 || maximumValues > 1_000) {
    throw new ErcotApiError("ercot_query_value_limit_invalid");
  }
  const allowed = new Set(allowedFields);
  const params = new URLSearchParams();
  let count = 0;
  for (const key of Object.keys(values).sort()) {
    if (!allowed.has(key)) throw new ErcotApiError("ercot_query_field_not_allowed");
    const entries = Array.isArray(values[key]) ? values[key] : [values[key]];
    for (const value of entries) {
      if (value === null || value === undefined) continue;
      if (++count > maximumValues) throw new ErcotApiError("ercot_query_value_limit_exceeded");
      params.append(key, String(value));
    }
  }
  return params.toString();
}

function openApiPaths(document: unknown): JsonObject {
  if (!isObject(document) || typeof document.openapi !== "string" || !isObject(document.paths)) {
    throw new ErcotApiError("ercot_openapi_document_invalid");
  }
  return document.paths;
}

function pathCandidates(endpointPath: string, apiBasePath: string): string[] {
  const candidates = [endpointPath];
  const prefix = apiBasePath.endsWith("/") ? apiBasePath.slice(0, -1) : apiBasePath;
  if (prefix && prefix !== "/" && endpointPath.startsWith(`${prefix}/`)) {
    candidates.push(endpointPath.slice(prefix.length));
  }
  return candidates;
}

function resolveParameter(parameter: unknown, document: JsonObject): unknown {
  if (!isObject(parameter) || typeof parameter.$ref !== "string") return parameter;
  if (!parameter.$ref.startsWith("#/")) return parameter;
  let current: unknown = document;
  for (const encodedPart of parameter.$ref.slice(2).split("/")) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !(part in current)) return parameter;
    current = current[part];
  }
  return current;
}

function operationParameters(pathItem: JsonObject, document: JsonObject): string[] {
  const result = new Set<string>();
  const sources = [
    pathItem.parameters,
    isObject(pathItem.get) ? pathItem.get.parameters : undefined,
  ];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const rawParameter of source) {
      const parameter = resolveParameter(rawParameter, document);
      if (
        isObject(parameter) &&
        parameter.in === "query" &&
        typeof parameter.name === "string" &&
        parameter.name
      ) {
        result.add(parameter.name);
      }
    }
  }
  return [...result].sort();
}

export function reconcileCatalogWithOpenApi(
  catalog: ErcotCatalog,
  document: unknown,
  options: { apiBasePath?: string } = {},
): OpenApiReconciliation {
  const paths = openApiPaths(document);
  const openApiDocument = document as JsonObject;
  const matched: OpenApiArtifact[] = [];
  const liveOnly: ErcotCatalogArtifact[] = [];
  const matchedPaths = new Set<string>();
  for (const artifact of catalog.artifacts) {
    const openApiPath = pathCandidates(
      artifact.endpointPath,
      options.apiBasePath ?? "/api/public-reports",
    ).find((candidate) => isObject(paths[candidate]));
    if (!openApiPath) {
      liveOnly.push(artifact);
      continue;
    }
    const pathItem = paths[openApiPath] as JsonObject;
    const methods = Object.keys(pathItem)
      .filter((key) => ["get", "post", "put", "patch", "delete"].includes(key))
      .sort();
    matched.push({
      ...artifact,
      methods,
      openApiPath,
      queryParameters: operationParameters(pathItem, openApiDocument),
    });
    matchedPaths.add(openApiPath);
  }
  const specOnlyPaths = Object.keys(paths)
    .filter((path) => !matchedPaths.has(path))
    .sort();
  return { liveOnly, matched, specOnlyPaths };
}

export function sourceProvenance(input: {
  artifact: ErcotCatalogArtifact;
  sourceId: string;
  sourceName: string;
  sourcePublicationTimestamp?: number;
}): SourceProvenance {
  const sourceId = requiredString(input.sourceId, "ercot_provenance_source_id_invalid");
  const sourceName = requiredString(input.sourceName, "ercot_provenance_source_name_invalid");
  if (
    input.sourcePublicationTimestamp !== undefined &&
    (!Number.isFinite(input.sourcePublicationTimestamp) || input.sourcePublicationTimestamp < 0)
  ) {
    throw new ErcotApiError("ercot_provenance_timestamp_invalid");
  }
  return {
    artifactPath: input.artifact.endpointPath,
    emilId: input.artifact.emilId,
    endpointHref: input.artifact.endpointHref,
    sourceId,
    sourceName,
    sourcePublicationTimestamp: input.sourcePublicationTimestamp,
    verifiedAt: input.artifact.verifiedAt,
  };
}

function parityKey(
  row: JsonObject,
  timestampField: string,
  categoryFields: readonly string[],
): string {
  const timestamp = row[timestampField];
  if (typeof timestamp !== "string" && typeof timestamp !== "number") {
    throw new ErcotApiError("ercot_parity_timestamp_invalid");
  }
  return JSON.stringify([timestamp, ...categoryFields.map((field) => row[field] ?? null)]);
}

function parityRows(
  rows: JsonObject[],
  timestampField: string,
  categoryFields: readonly string[],
): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const row of rows) {
    const key = parityKey(row, timestampField, categoryFields);
    if (result.has(key)) throw new ErcotApiError("ercot_parity_duplicate_key");
    result.set(key, row);
  }
  return result;
}

export function compareSourceParity(
  apiRows: JsonObject[],
  referenceRows: JsonObject[],
  options: {
    categoryFields?: readonly string[];
    maximumDiagnostics?: number;
    timestampField: string;
    tolerance?: number;
    unitField?: string;
    valueField: string;
  },
): ParityDiagnostics {
  const tolerance = options.tolerance ?? 0;
  const maximumDiagnostics = options.maximumDiagnostics ?? 20;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new ErcotApiError("ercot_parity_tolerance_invalid");
  }
  if (!Number.isInteger(maximumDiagnostics) || maximumDiagnostics < 0 || maximumDiagnostics > 100) {
    throw new ErcotApiError("ercot_parity_diagnostic_limit_invalid");
  }
  const categories = options.categoryFields ?? [];
  const api = parityRows(apiRows, options.timestampField, categories);
  const reference = parityRows(referenceRows, options.timestampField, categories);
  const allKeys = [...new Set([...api.keys(), ...reference.keys()])].sort();
  const mismatches: ParityDiagnostics["mismatches"] = [];
  let mismatchCount = 0;
  const recordMismatch = (mismatch: ParityDiagnostics["mismatches"][number]) => {
    mismatchCount++;
    if (mismatches.length < maximumDiagnostics) mismatches.push(mismatch);
  };
  let aligned = 0;
  let matched = 0;
  let missingApi = 0;
  let missingReference = 0;
  let unitMismatches = 0;
  let valueComparisons = 0;
  let valueMismatches = 0;
  let maximumAbsoluteDelta: number | null = null;
  let absoluteDeltaTotal = 0;
  for (const key of allKeys) {
    const apiRow = api.get(key);
    const referenceRow = reference.get(key);
    if (!apiRow) {
      missingApi++;
      recordMismatch({ key, reason: "missing_api" });
      continue;
    }
    if (!referenceRow) {
      missingReference++;
      recordMismatch({ key, reason: "missing_reference" });
      continue;
    }
    aligned++;
    if (options.unitField && apiRow[options.unitField] !== referenceRow[options.unitField]) {
      unitMismatches++;
      recordMismatch({
        api: apiRow[options.unitField],
        key,
        reason: "unit",
        reference: referenceRow[options.unitField],
      });
      continue;
    }
    const apiValue = apiRow[options.valueField];
    const referenceValue = referenceRow[options.valueField];
    if (
      typeof apiValue !== "number" ||
      typeof referenceValue !== "number" ||
      !Number.isFinite(apiValue) ||
      !Number.isFinite(referenceValue)
    ) {
      throw new ErcotApiError("ercot_parity_value_invalid");
    }
    const absoluteDelta = Math.abs(apiValue - referenceValue);
    valueComparisons++;
    absoluteDeltaTotal += absoluteDelta;
    maximumAbsoluteDelta = Math.max(maximumAbsoluteDelta ?? 0, absoluteDelta);
    if (absoluteDelta > tolerance) {
      valueMismatches++;
      recordMismatch({ api: apiValue, key, reason: "value", reference: referenceValue });
      continue;
    }
    matched++;
  }
  return {
    aligned,
    apiRows: apiRows.length,
    matched,
    maximumAbsoluteDelta,
    meanAbsoluteDelta: valueComparisons === 0 ? null : absoluteDeltaTotal / valueComparisons,
    mismatches,
    missingApi,
    missingReference,
    referenceRows: referenceRows.length,
    truncated: mismatchCount > maximumDiagnostics,
    unitMismatches,
    valueComparisons,
    valueMismatches,
  };
}

export function estimateStorageCost(input: {
  bytesPerRow: number;
  indexOverheadRatio?: number;
  publicationsPerDay: number;
  retentionDays: number;
  rowsPerPublication: number;
}): StorageCostEstimate {
  const indexOverheadRatio = input.indexOverheadRatio ?? 0.35;
  for (const value of [
    input.bytesPerRow,
    input.publicationsPerDay,
    input.retentionDays,
    input.rowsPerPublication,
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ErcotApiError("ercot_storage_estimate_input_invalid");
    }
  }
  if (!Number.isFinite(indexOverheadRatio) || indexOverheadRatio < 0 || indexOverheadRatio > 5) {
    throw new ErcotApiError("ercot_storage_estimate_input_invalid");
  }
  const rowsPerDay = input.rowsPerPublication * input.publicationsPerDay;
  const rawBytesPerDay = rowsPerDay * input.bytesPerRow;
  const bytesPerDayWithIndexes = rawBytesPerDay * (1 + indexOverheadRatio);
  const retainedBytesWithIndexes = bytesPerDayWithIndexes * input.retentionDays;
  const retainedRows = rowsPerDay * input.retentionDays;
  if (
    ![
      rowsPerDay,
      rawBytesPerDay,
      bytesPerDayWithIndexes,
      retainedBytesWithIndexes,
      retainedRows,
    ].every(Number.isFinite)
  ) {
    throw new ErcotApiError("ercot_storage_estimate_input_invalid");
  }
  return {
    bytesPerDayWithIndexes,
    bytesPerYearWithIndexes: bytesPerDayWithIndexes * 365,
    rawBytesPerDay,
    retainedBytesWithIndexes,
    retainedRows,
    rowsPerDay,
    thirtyDayBytesWithIndexes: bytesPerDayWithIndexes * 30,
  };
}
