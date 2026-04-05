// Popup script — handles dashboard and profile tabs

document.addEventListener("DOMContentLoaded", () => {
  // Initialize tabs
  initTabs();

  // Initialize dashboard
  initDashboard();

  // Initialize profile
  initProfile();
});

/* ─────────────── TAB MANAGEMENT ─────────────── */

function initTabs() {
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.getAttribute("data-tab");

      // Deactivate all tabs
      tabButtons.forEach((b) => b.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));

      // Activate selected tab
      btn.classList.add("active");
      document.getElementById(tabName).classList.add("active");
    });
  });
}

/* ─────────────── DASHBOARD TAB ─────────────── */

function initDashboard() {
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
    if (confirm("Are you sure you want to clear all scraped jobs and stats?")) {
      chrome.storage.local.set({ scrapedJobs: [], sentJobsCount: 0 }, () => {
        scrapedCount.textContent = "0";
        sentCount.textContent = "0";
      });
    }
  });
}

/* ─────────────── PROFILE TAB ─────────────── */

function initProfile() {
  const profileFields = {
    firstName: document.getElementById("firstName"),
    lastName: document.getElementById("lastName"),
    email: document.getElementById("email"),
    phone: document.getElementById("phone"),
    address: document.getElementById("address"),
    city: document.getElementById("city"),
    province: document.getElementById("province"),
    postalCode: document.getElementById("postalCode"),
    linkedin: document.getElementById("linkedin"),
    github: document.getElementById("github"),
    portfolio: document.getElementById("portfolio"),
    currentCompany: document.getElementById("currentCompany"),
    pronouns: document.getElementById("pronouns"),
    workAuth: document.getElementById("workAuth"),
    howDidYouHear: document.getElementById("howDidYouHear"),
  };

  const saveBtn = document.getElementById("save-profile");
  const saveFeedback = document.getElementById("save-feedback");

  // Load existing profile on open
  loadProfile(profileFields);

  // Save profile on button click
  saveBtn.addEventListener("click", () => {
    saveProfile(profileFields, saveFeedback);
  });
}

function loadProfile(fields) {
  chrome.storage.local.get(["userProfile"], (result) => {
    const profile = result.userProfile || {};

    // Map stored field names to input IDs
    const fieldMap = {
      firstName: "firstName",
      lastName: "lastName",
      email: "email",
      phone: "phone",
      address: "address",
      city: "city",
      province: "province",
      postalCode: "postalCode",
      linkedin: "linkedin",
      github: "github",
      portfolio: "portfolio",
      currentCompany: "currentCompany",
      pronouns: "pronouns",
      requireSponsorship: "workAuth", // Note: different name in storage vs UI
      howDidYouHear: "howDidYouHear",
    };

    // Fill in stored values
    for (const [storageKey, fieldId] of Object.entries(fieldMap)) {
      const field = fields[fieldId];
      if (field && profile[storageKey]) {
        field.value = profile[storageKey];
      }
    }
  });
}

function saveProfile(fields, feedback) {
  const profile = {
    firstName: fields.firstName.value.trim(),
    lastName: fields.lastName.value.trim(),
    email: fields.email.value.trim(),
    phone: fields.phone.value.trim(),
    address: fields.address.value.trim(),
    city: fields.city.value.trim(),
    province: fields.province.value.trim(),
    postalCode: fields.postalCode.value.trim(),
    linkedin: fields.linkedin.value.trim(),
    github: fields.github.value.trim(),
    portfolio: fields.portfolio.value.trim(),
    currentCompany: fields.currentCompany.value.trim(),
    pronouns: fields.pronouns.value,
    requireSponsorship: fields.workAuth.value,
    howDidYouHear: fields.howDidYouHear.value,
  };

  // Validate minimum required fields
  if (!profile.firstName || !profile.email) {
    alert("Please fill in at least First Name and Email");
    return;
  }

  // Save to chrome.storage.local
  chrome.storage.local.set({ userProfile: profile }, () => {
    console.log("AutoApply: Profile saved", profile);

    // Show feedback
    feedback.classList.add("show");
    setTimeout(() => {
      feedback.classList.remove("show");
    }, 2000);
  });
}
