// Popup script — loads stats and handles settings

document.addEventListener("DOMContentLoaded", () => {
  const urlInput = document.getElementById("url-input");
  const openBtn = document.getElementById("open-pipeline");
  const clearBtn = document.getElementById("clear-data");
  const scrapedCount = document.getElementById("scraped-count");
  const sentCount = document.getElementById("sent-count");

  // Load settings
  chrome.storage.local.get(
    ["autoapplyUrl", "scrapedJobs", "sentJobsCount"],
    (result) => {
      if (result.autoapplyUrl) {
        urlInput.value = result.autoapplyUrl;
      }
      scrapedCount.textContent = result.scrapedJobs?.length ?? 0;
      sentCount.textContent = result.sentJobsCount ?? 0;
    }
  );

  // Save URL on change
  urlInput.addEventListener("change", () => {
    chrome.storage.local.set({ autoapplyUrl: urlInput.value.trim() });
  });

  // Open Pipeline
  openBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (url) {
      chrome.tabs.create({ url: `${url}/pipeline` });
    } else {
      alert("Please enter your AutoApply URL first");
    }
  });

  // Clear data
  clearBtn.addEventListener("click", () => {
    chrome.storage.local.set({ scrapedJobs: [], sentJobsCount: 0 }, () => {
      scrapedCount.textContent = "0";
      sentCount.textContent = "0";
    });
  });
});
