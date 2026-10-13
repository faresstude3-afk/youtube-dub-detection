/**
 * YouTube Arabic Dub Indicator - Popup Logic (v1.8.0)
 * Master toggle switch, live preview, and instant customization.
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

document.addEventListener('DOMContentLoaded', () => {
  const masterToggle = document.getElementById('masterToggle');
  const switchStatusText = document.getElementById('switchStatusText');
  const previewCard = document.getElementById('previewCard');
  const controlsGroup = document.getElementById('controlsGroup');
  const liveBadgePreview = document.getElementById('liveBadgePreview');
  const previewBadgeText = document.getElementById('previewBadgeText');
  const themeButtons = document.querySelectorAll('#themeSelector .theme-btn');
  const textButtons = document.querySelectorAll('#textSelector .pill-btn');
  const posButtons = document.querySelectorAll('#positionSelector .seg-btn');

  let currentSettings = {
    isEnabled: true,
    badgeTheme: 'indigo',
    badgeText: 'دبلجة عربية',
    badgePosition: 'right'
  };

  function updateUI() {
    // Update Master Toggle state
    const isEnabled = currentSettings.isEnabled !== false;
    masterToggle.checked = isEnabled;
    switchStatusText.textContent = isEnabled ? 'مفعّل' : 'معطّل';
    previewCard.classList.toggle('is-disabled', !isEnabled);
    controlsGroup.classList.toggle('is-disabled', !isEnabled);

    // Update Live Preview Card
    liveBadgePreview.setAttribute('data-theme', currentSettings.badgeTheme);
    previewBadgeText.textContent = currentSettings.badgeText;
    if (currentSettings.badgePosition === 'left') {
      liveBadgePreview.classList.add('is-left');
    } else {
      liveBadgePreview.classList.remove('is-left');
    }

    // Update Active Button States
    themeButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === currentSettings.badgeTheme);
    });
    textButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === currentSettings.badgeText);
    });
    posButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === currentSettings.badgePosition);
    });
  }

  function saveSettings() {
    updateUI();
    browserAPI.storage.local.set({ yt_dub_settings: currentSettings });
  }

  // Load saved settings
  browserAPI.storage.local.get(['yt_dub_settings'], (res) => {
    if (res && res.yt_dub_settings) {
      Object.assign(currentSettings, res.yt_dub_settings);
    }
    updateUI();
  });

  // Master switch event
  masterToggle.addEventListener('change', () => {
    currentSettings.isEnabled = masterToggle.checked;
    saveSettings();
  });

  // Bind click events
  themeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentSettings.badgeTheme = btn.dataset.value;
      saveSettings();
    });
  });

  textButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentSettings.badgeText = btn.dataset.value;
      saveSettings();
    });
  });

  posButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentSettings.badgePosition = btn.dataset.value;
      saveSettings();
    });
  });
});
