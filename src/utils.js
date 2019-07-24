export const isIE = () => {
  const ua = window.navigator.userAgent;
  const msie = ua.indexOf("MSIE ") > -1;
  const msie11 = ua.indexOf("Trident/") > -1;
  const isEdge = ua.indexOf("Edge/") > -1;

  return msie || msie11 || isEdge;
};

export const requiresInteraction = errorMessage => {
  if (!errorMessage || !errorMessage.length) {
    return false;
  }

  return (
    errorMessage.indexOf("consent_required") > -1 ||
    errorMessage.indexOf("interaction_required") > -1 ||
    errorMessage.indexOf("login_required") > -1
  );
};

export const expiry = token => {
  token = sessionStorage.getItem(token);
  if (!token) return 0;

  const expiresAt = new Date(
    JSON.parse(window.atob(token.split(".")[1])).exp * 1000
  );
  const currentTime = new Date();

  return (expiresAt.getTime() - currentTime.getTime()) / 1000; // Seconds to expiry
};

export const timer = token => {
  const secondsToExpiry = expiry(token);
  const roundedMinutes = Math.max(Math.floor(secondsToExpiry / 60), 0);
  return [
    roundedMinutes, // Rounded minutes to expiry
    Math.trunc(secondsToExpiry - roundedMinutes * 60) // Remaining seconds
  ];
};
