// What the model is told when the search service errors, so it does not answer from memory.
export const SEARCH_FAILED =
  'SEARCH FAILED: the search service is temporarily unavailable. Do not answer from memory. Tell the user you could not search right now and to try again in a minute.';

// True when a search server's reply is an error message rather than results. Only the start of the text counts, so results that
// merely mention "search failed" (a question about that error message, say) are not mistaken for a failure.
export const isSearchFailure = (text) => /^\s*(error\b|search failed\b)/i.test(text);
