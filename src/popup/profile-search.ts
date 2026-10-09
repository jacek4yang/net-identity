import type { IdentityProfile } from "../profile/schema";

/** Literal, bounded display-only search. No credential or identity-provider fields. */
export function filterProfiles(
  profiles: readonly IdentityProfile[],
  query: string,
): readonly IdentityProfile[] {
  const terms = query.slice(0, 128).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return profiles;
  return profiles.filter((profile) => {
    const text = [
      profile.name,
      profile.proxy.type,
      profile.proxy.host ?? "",
      String(profile.proxy.port ?? ""),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
