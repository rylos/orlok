import type { Person } from "@orlok/shared";

// A member with no office signs in to an empty workspace and can do nothing until an
// administrator gives them one. Administrators work in every office; disabled people cannot
// sign in at all.
export function isWithoutOffice(person: Person) {
  return person.role === "member" && !person.disabled && person.memberships.length === 0;
}
