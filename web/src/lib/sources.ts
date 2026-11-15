import { domainOf } from "./format.js";
import type { Citation, SourceDetail, TurnSource } from "./types.js";

export function sourceFromTurn(source: TurnSource): SourceDetail {
  return {
    label: source.label,
    title: source.title,
    url: source.url,
    domain: source.domain,
    publishedAt: source.publishedAt,
    fetchedAt: source.fetchedAt,
    snippet: source.snippet,
  };
}

export function sourceFromCitation(citation: Citation): SourceDetail {
  return {
    label: citation.id,
    title: citation.title,
    url: citation.url,
    domain: domainOf(citation.url),
    publishedAt: citation.publishedAt,
    fetchedAt: null,
    snippet: citation.snippet,
  };
}
