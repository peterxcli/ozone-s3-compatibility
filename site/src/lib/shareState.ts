import type { SearchResult } from "./search";

export const SEARCH_SECTION_HASH = "#search-section";
export const SEARCH_QUERY_PARAM = "q";
export const SEARCH_SUITE_PARAM = "suite";
export const SEARCH_RUN_PARAM = "run";
export const SEARCH_CASE_SUITE_PARAM = "caseSuite";
export const SEARCH_TEST_PARAM = "test";

export interface SharedCaseIdentity {
  runId: string;
  suiteKey: string;
  testName: string;
}

export interface SearchShareState {
  query: string;
  suiteFilter: string;
  selectedCase: SharedCaseIdentity | null;
}

function browserHref(): string {
  return typeof window === "undefined" ? "https://example.test/" : window.location.href;
}

export function caseIdentityForResult(result: SearchResult): SharedCaseIdentity {
  return {
    runId: result.runId,
    suiteKey: result.suiteKey,
    testName: result.testName || result.sourceSymbol || "",
  };
}

export function parseSearchShareState(href = browserHref()): SearchShareState {
  const url = new URL(href, browserHref());
  const query = url.searchParams.get(SEARCH_QUERY_PARAM)?.trim() || "";
  const suiteFilter = url.searchParams.get(SEARCH_SUITE_PARAM)?.trim() || "all";

  return {
    query,
    suiteFilter: suiteFilter || "all",
    selectedCase: parseSharedCaseIdentity(href),
  };
}

export function parseSharedCaseIdentity(href = browserHref()): SharedCaseIdentity | null {
  const url = new URL(href, browserHref());
  const runId = url.searchParams.get(SEARCH_RUN_PARAM)?.trim() || "";
  const suiteKey = url.searchParams.get(SEARCH_CASE_SUITE_PARAM)?.trim() || "";
  const testName = url.searchParams.get(SEARCH_TEST_PARAM)?.trim() || "";
  return runId && testName ? { runId, suiteKey, testName } : null;
}

export function searchUrlFromState(
  state: {
    query?: string;
    suiteFilter?: string;
    selectedCase?: SharedCaseIdentity | null;
  },
  href = browserHref(),
): string {
  const url = new URL(href, browserHref());
  const query = state.query?.trim() || "";
  const suiteFilter = state.suiteFilter?.trim() || "all";
  const selectedCase = state.selectedCase || null;

  if (query) {
    url.searchParams.set(SEARCH_QUERY_PARAM, query);
  } else {
    url.searchParams.delete(SEARCH_QUERY_PARAM);
  }

  if (suiteFilter && suiteFilter !== "all") {
    url.searchParams.set(SEARCH_SUITE_PARAM, suiteFilter);
  } else {
    url.searchParams.delete(SEARCH_SUITE_PARAM);
  }

  url.searchParams.delete(SEARCH_RUN_PARAM);
  url.searchParams.delete(SEARCH_CASE_SUITE_PARAM);
  url.searchParams.delete(SEARCH_TEST_PARAM);
  if (selectedCase) {
    url.searchParams.set(SEARCH_RUN_PARAM, selectedCase.runId);
    if (selectedCase.suiteKey) {
      url.searchParams.set(SEARCH_CASE_SUITE_PARAM, selectedCase.suiteKey);
    }
    url.searchParams.set(SEARCH_TEST_PARAM, selectedCase.testName);
  }

  if (query || selectedCase) {
    url.hash = SEARCH_SECTION_HASH;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function runDetailCaseUrlFromState(
  state: {
    selectedCase: SharedCaseIdentity;
    hash: string;
  },
  href = browserHref(),
): string {
  const url = new URL(href, browserHref());
  const hash = state.hash.trim().replace(/^#/, "");

  url.searchParams.delete(SEARCH_QUERY_PARAM);
  url.searchParams.delete(SEARCH_SUITE_PARAM);
  url.searchParams.set(SEARCH_RUN_PARAM, state.selectedCase.runId);
  if (state.selectedCase.suiteKey) {
    url.searchParams.set(SEARCH_CASE_SUITE_PARAM, state.selectedCase.suiteKey);
  } else {
    url.searchParams.delete(SEARCH_CASE_SUITE_PARAM);
  }
  url.searchParams.set(SEARCH_TEST_PARAM, state.selectedCase.testName);
  url.hash = hash ? `#${hash}` : "";

  return `${url.pathname}${url.search}${url.hash}`;
}

export function resultMatchesSharedCase(result: SearchResult, selectedCase: SharedCaseIdentity): boolean {
  if (result.runId !== selectedCase.runId) {
    return false;
  }
  if (selectedCase.suiteKey && result.suiteKey !== selectedCase.suiteKey) {
    return false;
  }
  return result.testName === selectedCase.testName || result.sourceSymbol === selectedCase.testName;
}
