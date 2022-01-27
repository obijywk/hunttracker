const darkModeToggle = document.getElementById("mode-toggle");
let darkMode = localStorage.getItem("passport-dark-mode");

const enableDarkMode = () => {
  document.documentElement.setAttribute("data-theme", "dark");
  localStorage.setItem("passport-dark-mode", "enabled");
};

const disableDarkMode = () => {
  document.documentElement.setAttribute("data-theme", "light");
  localStorage.setItem("passport-dark-mode", "disabled");
};

if (darkMode === "enabled") {
  enableDarkMode(); // set state of darkMode on page load
}

darkModeToggle.addEventListener("click", (e) => {
  darkMode = localStorage.getItem("passport-dark-mode"); // update darkMode when clicked
  if (darkMode === "disabled") {
    enableDarkMode();
  } else {
    disableDarkMode();
  }
});
