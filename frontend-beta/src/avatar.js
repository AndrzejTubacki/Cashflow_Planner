export const AVATAR_IDS = Object.freeze([
  "fox", "owl", "cat", "whale", "cactus", "rocket",
  "mushroom", "robot", "penguin", "hedgehog", "ghost", "planet"
]);

export function defaultAvatarId(accountId = "") {
  let hash = 0;
  for (const character of String(accountId)) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return AVATAR_IDS[hash % AVATAR_IDS.length];
}

export function resolvedAvatarId(account = {}) {
  return AVATAR_IDS.includes(account.avatar) ? account.avatar : defaultAvatarId(account.id);
}
