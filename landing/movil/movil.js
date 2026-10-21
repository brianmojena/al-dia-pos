const LINKS = {
  web: "https://client-tan-one-13.vercel.app",
  android: "https://github.com/brianmojena/al-dia-dashboard/releases/latest",
};

document.querySelectorAll("[data-link]").forEach((link) => {
  const target = LINKS[link.dataset.link];
  if (target) link.href = target;
});

const year = document.getElementById("year");
if (year) year.textContent = new Date().getFullYear();

const receiptDate = document.getElementById("receipt-date");
if (receiptDate) {
  try {
    const formatted = new Intl.DateTimeFormat("es-CU", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date());
    receiptDate.textContent = formatted.charAt(0).toUpperCase() + formatted.slice(1);
  } catch (error) {
    receiptDate.textContent = "Cierre de ejemplo";
  }
}

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

if (isIOS) {
  const note = document.getElementById("ios-note");
  if (note) note.hidden = false;
}

const dock = document.getElementById("dock");
const heroCta = document.getElementById("hero-cta");
const finalCta = document.getElementById("final-cta");

if (dock && heroCta && finalCta && "IntersectionObserver" in window) {
  let heroVisible = true;
  let finalVisible = false;

  const syncDock = () => {
    dock.classList.toggle("is-on", !heroVisible && !finalVisible);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.target === heroCta) heroVisible = entry.isIntersecting;
        if (entry.target === finalCta) finalVisible = entry.isIntersecting;
      });
      syncDock();
    },
    { threshold: 0 }
  );

  observer.observe(heroCta);
  observer.observe(finalCta);
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const value = button.dataset.copy;

    try {
      await navigator.clipboard.writeText(value);
    } catch (error) {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }

    button.textContent = "Copiado";
    window.setTimeout(() => {
      button.textContent = "Copiar";
    }, 1600);
  });
});
