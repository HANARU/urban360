// Highlights the sidebar entry for the section in view, on all three
// Urban360 documentation pages.

document.addEventListener("DOMContentLoaded", function() {
  const sections = document.querySelectorAll('.section-block');
  const navLinks = document.querySelectorAll('.rtd-sidebar-nav a');
  const mainContent = document.getElementById('main-content');

  // On mobile the page scrolls as one document, so the observer roots on the
  // viewport instead of the main column and the sidebar is left where it is.
  const onMobile = window.matchMedia('(max-width: 768px)').matches;
  const scrollBox = onMobile ? document.scrollingElement : mainContent;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(entry.isIntersecting) {
        navLinks.forEach(link => {
          link.classList.remove('active');
          if(link.getAttribute('href').endsWith('#' + entry.target.id)) {
            link.classList.add('active');
            if (!onMobile) link.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        });
      }
    });
  }, { root: onMobile ? null : mainContent, rootMargin: "-10% 0px -70% 0px", threshold: 0 });

  sections.forEach(section => observer.observe(section));

  // Fallback: highlight the last section when scrolled to the absolute bottom
  (onMobile ? window : mainContent).addEventListener('scroll', () => {
    if (scrollBox.scrollHeight - scrollBox.scrollTop <= scrollBox.clientHeight + 5) {
      const lastSection = sections[sections.length - 1];
      if (lastSection) {
        navLinks.forEach(link => {
          link.classList.remove('active');
          if(link.getAttribute('href').endsWith('#' + lastSection.id)) {
            link.classList.add('active');
            if (!onMobile) link.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        });
      }
    }
  });
});
