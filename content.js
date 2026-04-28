chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "extract-page-data") {
    return;
  }

  const extractor = globalThis.BTDPageExtractor;
  if (!extractor?.extractPageData) {
    sendResponse({
      ok: false,
      error: "Shared page extractor is not loaded in this tab."
    });
    return;
  }

  sendResponse({
    ok: true,
    pageData: extractor.extractPageData()
  });
});
