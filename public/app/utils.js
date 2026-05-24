export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    };

    return entities[character];
  });
}

export function formatClock(date) {
  return date.toLocaleString("en-GB", {
    month: "short",
    day: "numeric",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatDay(dateString, timeZone) {
  return new Date(dateString).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone
  });
}

export function formatHour(dateString, timeZone) {
  return new Date(dateString).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone
  });
}

export function formatDateTime(dateString, timeZone) {
  return new Date(dateString).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone
  });
}

export function formatRelativeAge(dateString, now = new Date()) {
  if (!dateString) {
    return "--";
  }

  const then = new Date(dateString);
  if (Number.isNaN(then.getTime())) {
    return "--";
  }

  const deltaMs = now.getTime() - then.getTime();
  const deltaMinutes = Math.max(0, Math.round(deltaMs / 60000));

  if (deltaMinutes < 1) {
    return "just now";
  }

  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

export function normalizePath(pathname) {
  if (!pathname || pathname === "/") {
    return "/dashboard";
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}
