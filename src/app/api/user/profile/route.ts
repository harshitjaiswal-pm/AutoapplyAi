import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis, userProfileKey } from "@/lib/redis";

export interface StoredProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  province: string;
  address: string;
  postalCode: string;
  linkedin: string;
  github: string;
  portfolio: string;
  currentCompany: string;
  pronouns: string;
  requireSponsorship: string;
  salaryExpectation?: string;
  savedAt: string;
}

/**
 * GET /api/user/profile
 * Returns the stored profile for the logged-in user.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id?: string }).id || session.user.email!;

  try {
    const data = await redis.get<StoredProfile>(userProfileKey(userId));
    if (!data) return NextResponse.json({ profile: null });
    return NextResponse.json({ profile: data });
  } catch (err) {
    console.error("Failed to fetch profile from Redis:", err);
    return NextResponse.json({ error: "Failed to load profile" }, { status: 500 });
  }
}

/**
 * POST /api/user/profile
 * Saves the profile for the logged-in user.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id?: string }).id || session.user.email!;

  try {
    const body = await request.json();

    if (!body.firstName || !body.email) {
      return NextResponse.json({ error: "Missing required fields (firstName, email)" }, { status: 400 });
    }

    const payload: StoredProfile = {
      firstName: body.firstName || "",
      lastName: body.lastName || "",
      email: body.email || "",
      phone: body.phone || "",
      city: body.city || "",
      province: body.province || "",
      address: body.address || "",
      postalCode: body.postalCode || "",
      linkedin: body.linkedin || "",
      github: body.github || "",
      portfolio: body.portfolio || "",
      currentCompany: body.currentCompany || "",
      pronouns: body.pronouns || "",
      requireSponsorship: body.requireSponsorship || "no",
      salaryExpectation: body.salaryExpectation || "",
      savedAt: new Date().toISOString(),
    };

    await redis.set(userProfileKey(userId), payload);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to save profile to Redis:", err);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }
}
