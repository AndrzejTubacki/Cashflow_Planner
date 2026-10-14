import { AVATAR_IDS, resolvedAvatarId } from "./avatar.js";

export const AVATAR_LABELS = Object.freeze({
  fox: "Fox", owl: "Owl", cat: "Cat", whale: "Whale", cactus: "Cactus", rocket: "Rocket",
  mushroom: "Mushroom", robot: "Robot", penguin: "Penguin", hedgehog: "Hedgehog", ghost: "Ghost", planet: "Planet"
});

const backgrounds = {
  fox: "#f08a4b", owl: "#7a68b8", cat: "#db6f83", whale: "#3d91bd", cactus: "#47a475", rocket: "#596bc5",
  mushroom: "#c85d67", robot: "#5f879d", penguin: "#41657b", hedgehog: "#b87951", ghost: "#8a78c5", planet: "#836bc0"
};

function Face({ ears = null, children = null }) {
  return <>{ears}<path d="M12 14c0-4.4 3.1-7 8-7s8 2.6 8 7v5c0 4.5-3.5 8-8 8s-8-3.5-8-8z" fill="#fff4df"/><circle cx="17" cy="17" r="1.2" fill="#263348"/><circle cx="23" cy="17" r="1.2" fill="#263348"/>{children}</>;
}

const drawings = {
  fox: <Face ears={<><path d="M12 12 10 5l7 4M28 12l2-7-7 4" fill="#fff4df"/></>}><path d="m16 22 4 3 4-3-4 1z" fill="#263348"/></Face>,
  owl: <><path d="M11 13c0-5 4-8 9-8s9 3 9 8v13H11z" fill="#f6d889"/><circle cx="16" cy="16" r="4" fill="#fff"/><circle cx="24" cy="16" r="4" fill="#fff"/><circle cx="16" cy="16" r="1.4" fill="#263348"/><circle cx="24" cy="16" r="1.4" fill="#263348"/><path d="m18 20 2 3 2-3z" fill="#e88445"/></>,
  cat: <Face ears={<><path d="M12 12 11 5l6 4M28 12l1-7-6 4" fill="#fff4df"/></>}><path d="m18 21 2 1 2-1-2 3zM14 21H8m18 0h6" stroke="#263348" strokeWidth="1.2" fill="none"/></Face>,
  whale: <><path d="M8 21c0-7 5-11 13-11 6 0 10 3 11 8-3 7-10 10-18 8-4-1-6-3-6-5z" fill="#d6f3ff"/><path d="M9 17C5 13 5 9 7 7c3 2 5 5 4 9M9 17C4 17 2 20 3 23c3 0 6-1 8-4" fill="#d6f3ff"/><circle cx="25" cy="16" r="1.3" fill="#263348"/><path d="M29 10c0-3 2-5 4-5M29 10c0-3-2-5-4-5" stroke="#d6f3ff" strokeWidth="2" fill="none"/></>,
  cactus: <><path d="M16 29V13c0-3 2-5 4-5s4 2 4 5v16z" fill="#d9f0b7"/><path d="M16 19h-3c-2 0-3-1-3-3v-3M24 22h3c2 0 3-1 3-3v-3" stroke="#d9f0b7" strokeWidth="4" strokeLinecap="round"/><circle cx="19" cy="15" r="1" fill="#263348"/><circle cx="23" cy="15" r="1" fill="#263348"/><path d="M19 19c1 1 3 1 4 0" stroke="#263348" fill="none"/></>,
  rocket: <><path d="M20 5c6 4 8 11 4 18l-4 5-4-5c-4-7-2-14 4-18z" fill="#f4f0ff"/><circle cx="20" cy="14" r="3" fill="#8ed7f0"/><path d="m15 20-5 5 6 1m9-6 5 5-6 1M18 27l2 7 2-7" fill="#ffc45f"/></>,
  mushroom: <><path d="M16 19h8l2 11H14z" fill="#fff1d0"/><path d="M8 19c1-8 6-12 12-12s11 4 12 12z" fill="#ffe7e4"/><circle cx="15" cy="13" r="2" fill="#c85d67"/><circle cx="25" cy="15" r="1.6" fill="#c85d67"/><circle cx="18" cy="24" r="1" fill="#263348"/><circle cx="22" cy="24" r="1" fill="#263348"/></>,
  robot: <><rect x="10" y="10" width="20" height="17" rx="5" fill="#dcecf3"/><path d="M20 10V6m-2 0h4" stroke="#dcecf3" strokeWidth="2"/><circle cx="16" cy="17" r="2" fill="#44748e"/><circle cx="24" cy="17" r="2" fill="#44748e"/><path d="M15 23h10" stroke="#44748e" strokeWidth="1.5"/><path d="M10 16H7v6h3m20-6h3v6h-3" fill="#dcecf3"/></>,
  penguin: <><ellipse cx="20" cy="20" rx="10" ry="14" fill="#263348"/><ellipse cx="20" cy="22" rx="7" ry="10" fill="#f7f5ee"/><circle cx="16" cy="14" r="1.2" fill="#fff"/><circle cx="24" cy="14" r="1.2" fill="#fff"/><path d="m17 17 3 3 3-3-3-1z" fill="#f1a64d"/></>,
  hedgehog: <><path d="m7 24 3-5-2-4 5-2v-5l5 2 4-4 3 5 6 1-2 5 4 4-5 3z" fill="#7a503d"/><path d="M11 19c0-5 4-8 10-8 5 0 8 3 8 7 0 6-5 10-11 10-4 0-7-4-7-9z" fill="#f3d9b4"/><circle cx="21" cy="18" r="1.2" fill="#263348"/><circle cx="29" cy="20" r="1.5" fill="#263348"/></>,
  ghost: <><path d="M10 29V17c0-7 4-11 10-11s10 4 10 11v12l-5-3-5 3-5-3z" fill="#f7f3ff"/><circle cx="16" cy="17" r="1.4" fill="#5c4d78"/><circle cx="24" cy="17" r="1.4" fill="#5c4d78"/><path d="M17 22c2 1 4 1 6 0" stroke="#5c4d78" fill="none"/></>,
  planet: <><circle cx="20" cy="19" r="10" fill="#f2b866"/><path d="M14 13c3 1 5 0 7-3m-5 15c4-3 8-2 11-1" stroke="#d77762" strokeWidth="2" fill="none"/><path d="M5 25c4 4 15 3 23-1s11-9 7-12" stroke="#f5e7ff" strokeWidth="3" fill="none"/></>
};

export function AvatarIcon({ id, account, size = 28, className = "" }) {
  const resolved = id || resolvedAvatarId(account);
  return <svg className={className} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill={backgrounds[resolved] || backgrounds.fox}/>{drawings[resolved] || drawings.fox}</svg>;
}

export { AVATAR_IDS };
