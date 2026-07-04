document.getElementById('start').addEventListener('click', () => {
  const seconds = parseFloat(document.getElementById('seconds').value) || 0;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, { action: 'start', seconds });
  });
});

document.getElementById('stop').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, { action: 'stop' });
  });
});