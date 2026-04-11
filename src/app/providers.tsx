"use client";

import { useEffect } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { useAppStore } from "@/store/useAppStore";

/**
 * Clears all localStorage store data if the logged-in user doesn't match
 * what's stored. Prevents one user from seeing another user's data on a
 * shared machine (e.g. Kiran logging in on Harshit's laptop).
 */
function UserStoreGuard() {
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status !== "authenticated") return;

    const sessionEmail = session?.user?.email;
    if (!sessionEmail) return;

    const storedProfile = useAppStore.getState().userProfile;
    const storedEmail = storedProfile?.email;

    // If there's stored data belonging to a different user, wipe it
    if (storedEmail && storedEmail.toLowerCase() !== sessionEmail.toLowerCase()) {
      // Clear Zustand persisted store
      localStorage.removeItem("autoapply-pipeline");

      // Clear all other autoapply localStorage keys
      const keysToRemove = Object.keys(localStorage).filter((k) =>
        k.startsWith("autoapply") || k.startsWith("aa_")
      );
      keysToRemove.forEach((k) => localStorage.removeItem(k));

      // Reset Zustand in-memory state
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

      // Force a reload so the page re-renders clean
      window.location.reload();
    }
  }, [session, status]);

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
