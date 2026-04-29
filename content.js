chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "extract-page-data") {
    const extractor = globalThis.BTDPageExtractor;
    if (!extractor?.extractPageData) {
      sendResponse({
        ok: false,
        error: "Shared page extractor is not loaded in this tab."
      });
      return;
    }
    
    // Optionally expand team page first if requested
    if (message.expandTeamPage) {
      extractor.expandTeamPage().then(() => {
        sendResponse({
          ok: true,
          pageData: extractor.extractPageData()
        });
      });
      return true; // Keep channel open for async response
    }
    
    sendResponse({
      ok: true,
      pageData: extractor.extractPageData()
    });
    return;
  }
  
  if (message?.type === "discover-profile-links") {
    const extractor = globalThis.BTDPageExtractor;
    if (!extractor?.discoverProfileLinks) {
      sendResponse({
        ok: false,
        error: "Profile link discovery not available."
      });
      return;
    }
    sendResponse({
      ok: true,
      profileLinks: extractor.discoverProfileLinks()
    });
    return;
  }
  
  if (message?.type === "calculate-coverage-score") {
    const extractor = globalThis.BTDPageExtractor;
    if (!extractor?.calculateCoverageScore) {
      sendResponse({
        ok: false,
        error: "Coverage scoring not available."
      });
      return;
    }
    sendResponse({
      ok: true,
      coverageScore: extractor.calculateCoverageScore(message.people || [], message.pageData || {})
    });
    return;
  }
});
