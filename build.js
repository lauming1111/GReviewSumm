const fs = require('fs');
const path = require('path');

// Copy manifest and static files to dist
const filesToCopy = ['manifest.json', 'popup.html'];

filesToCopy.forEach(file => {
  const src = path.join(__dirname, file);
  const dest = path.join(__dirname, 'dist', file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} to dist/`);
  }
});

// Copy icons if they exist
const iconsDir = path.join(__dirname, 'icons');
const distIconsDir = path.join(__dirname, 'dist', 'icons');
if (fs.existsSync(iconsDir)) {
  if (!fs.existsSync(distIconsDir)) fs.mkdirSync(distIconsDir, { recursive: true });
  fs.readdirSync(iconsDir).forEach(file => {
    fs.copyFileSync(path.join(iconsDir, file), path.join(distIconsDir, file));
  });
}

// Strip export statements from compiled files (needed for Chrome extension scripts)
const filesToClean = ['content.js', 'background.js', 'popup.js'];
const distDir = path.join(__dirname, 'dist');

filesToClean.forEach(file => {
  const filePath = path.join(distDir, file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    // Remove all export statements
    content = content.replace(/export\s+\{[^}]*\};?\s*$/gm, '').replace(/export\s+\*\s+from\s+[^;]+;/gm, '');
    fs.writeFileSync(filePath, content);
  }
});

// Copy everything from dist to the extension folder
const extensionDir = path.join(__dirname, '..', 'review-lens-extension');
if (fs.existsSync(extensionDir)) {
  fs.readdirSync(distDir).forEach(file => {
    const src = path.join(distDir, file);
    const dest = path.join(extensionDir, file);
    if (fs.statSync(src).isDirectory()) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src).forEach(subfile => {
        fs.copyFileSync(path.join(src, subfile), path.join(dest, subfile));
      });
    } else {
      fs.copyFileSync(src, dest);
    }
  });
  console.log('Copied files to review-lens-extension/');
}

console.log('Build complete!');
