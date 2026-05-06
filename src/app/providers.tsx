"use client";

import { useEffect } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { useAppStore } from "@/store/useAppStore";

/**
 * On login:
 * 1. If the stored data belongs to a different user, wipe localStorage and reset Zustand.
 * 2. Fetch the user's resume from the server (Redis) and hydrate the store + localStorage.
 *    This makes the resume available on any device without re-uploading.
 */
function UserStoreGuard() {
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status !== "authenticated") return;

    const sessionEmail = session?.user?.email;
    if (!sessionEmail) return;

    const storedProfile = useAppStore.getState().userProfile;
    const storedEmail = storedProfile?.email;

    // If there's stored data belonging to a different user, wipe it first
    if (storedEmail && storedEmail.toLowerCase() !== sessionEmail.toLowerCase()) {
      localStorage.removeItem("autoapply-pipeline");
      const keysToRemove = Object.keys(localStorage).filter((k) =>
        k.startsWith("autoapply") || k.startsWith("aa_")
      );
      keysToRemove.forEach((k) => localStorage.removeItem(k));
      useAppStore.setState({
        userProfile: null,
        parsedResumeSummary: null,
        pipelineJobs: [],
        applications: [],
        pipelineResumeText: "",
        pipelineParsedResume: null,
        rawResumeText: "",
        parsedResume: null,
      });
    }

    // Always fetch profile from Redis on auth — Redis is the source of truth.
    // Skipping when local cache exists caused cross-device staleness: a profile
    // updated on Laptop A was never pulled on Laptop B because B's localStorage
    // was already populated from a prior session.
    fetch("/api/user/profile")
      .then((r) => r.json())
      .then((data) => {
        const profile = data?.profile;
        if (!profile) return;

        // Remove server-only fields before hydrating the client store
        const { savedAt, ...clientProfile } = profile;

        // Hydrate Zustand
        useAppStore.setState({ userProfile: clientProfile });

        // Write to BOTH localStorage keys — aa_profile for the dashboard UI,
        // autoapply-user-profile for chrome-extension/pipeline-bridge.js.
        const profileJson = JSON.stringify(clientProfile);
        localStorage.setItem("aa_profile", profileJson);
        localStorage.setItem("autoapply-user-profile", profileJson);
        window.dispatchEvent(
          new CustomEvent("autoapply-sync-resume", { detail: { userProfile: clientProfile } })
        );

        document.cookie =
          "aa_onboarding_complete=true; path=/; max-age=31536000";
      })
      .catch((e) => console.warn("AutoApply: Failed to load profile from server", e));

    // Always fetch resume from Redis on auth (same reasoning as profile).
    fetch("/api/user/resume")
      .then((r) => r.json())
      .then((data) => {
        const resume = data?.resume;
        if (!resume) return;

        const { resumeText, parsedResume, parsedResumeSummary } = resume;

        useAppStore.setState({
          rawResumeText: resumeText,
          pipelineResumeText: resumeText,
          pipelineParsedResume: parsedResume,
          parsedResumeSummary,
        });

        localStorage.setItem("autoapply-parsed-resume", JSON.stringify(parsedResume));
        window.dispatchEvent(
          new CustomEvent("autoapply-sync-resume", { detail: { parsedResume } })
        );
      })
      .catch((e) => console.warn("AutoApply: Failed to load resume from server", e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <UserStoreGuard />
      {children}
    </SessionProvider>
  );
}
