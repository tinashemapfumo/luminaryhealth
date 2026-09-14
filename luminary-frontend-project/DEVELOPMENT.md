# Development Guide

Working on Luminary Health frontend? Start here.

---

## 📚 Understanding the Project

**Current Status:** Stage 1 - Frontend Demo (Complete)

This is a **frontend-first** approach:
1. Build beautiful, functional UI first (Stage 1) ✓
2. Add state management (Stage 2)
3. Build API integration (Stage 3)
4. Connect to real backend (Stage 6)

**Benefits:**
- Users see progress immediately
- UI/UX locked in before backend design
- Can present and get feedback early
- Backend can be built in parallel

---

## 🚀 Getting Started

### First Time Setup
```bash
# Clone/download the project
cd luminary-frontend-project

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local

# Start development
npm run dev
```

Open `http://127.0.0.1:5174`

### Daily Development
```bash
# Every morning, start the dev server
npm run dev

# It watches for changes and hot-reloads automatically
# Just edit files and see changes instantly
```

---

## 📁 Where to Make Changes

### **Stage 1 (Current)**
Everything is in: `src/components/LuminaryDemo.jsx`

This is one big component. It's intentional - it keeps the demo simple and contained.

**To customize:**
- Edit `src/components/LuminaryDemo.jsx`
- Search for the hardcoded data (patients, appointments, invoices)
- Change names, amounts, dates, etc.
- Browser auto-updates

### **Stage 2 (Next)**
Will split `LuminaryDemo.jsx` into:
```
src/
├── App.jsx
├── components/
│   ├── Sidebar.jsx          (navigation)
│   ├── TopBar.jsx           (header)
│   ├── pages/
│   │   ├── Dashboard.jsx
│   │   ├── Patients.jsx
│   │   ├── Appointments.jsx
│   │   ├── Billing.jsx
│   │   ├── Claims.jsx
│   │   └── AIAgents.jsx
│   └── ...
└── data/
    └── mockData.js          (move data here)
```

---

## 🎨 Making Changes

### Change Practice Name
Search for: `Practice Name Clinic`
Replace with: Your practice name

### Change Patient Data
In `LuminaryDemo.jsx`, find:
```javascript
const patients = [
  { id: 1, name: 'Alice Johnson', ... }
```

Edit names, phone numbers, dates, etc.

### Change Colors/Theme
Edit `tailwind.config.js`:
```javascript
theme: {
  extend: {
    colors: {
      primary: "#2563eb",  // Change this
      secondary: "#7c3aed"  // Or this
    }
  }
}
```

### Add a New Field to Patient
1. Find patient data in `LuminaryDemo.jsx`
2. Add field to patient object: `newField: 'value'`
3. Display it in the patient details table
4. Done!

---

## 🔧 Code Structure (Current Stage)

**Single component pattern:**
```
LuminaryDemo.jsx
├── State management (useState hooks)
├── Mock data (hardcoded)
├── Page components
│   ├── Dashboard
│   ├── PatientManagement
│   ├── Appointments
│   ├── Billing
│   ├── InsuranceClaims
│   └── AIAgents
├── Navigation (sidebar)
└── Rendering logic
```

**Why this way?**
- Simple to understand
- Easy to present (one file)
- Easy to customize
- No complexity overhead

**Stage 2 will refactor** this into modular components.

---

## 🧪 Testing Your Changes

### Check It Works
1. `npm run dev` (already running)
2. Edit a file
3. Browser should auto-update (in 1-2 seconds)
4. If not, hard refresh: `Ctrl+R` or `Cmd+R`

### Test on Different Devices
1. Development version works on:
   - Desktop (any modern browser)
   - Tablet (iPad, Android tablets)
   - Phone (landscape works great, portrait is tight)

2. To test on phone:
   - Get your computer's IP: `ipconfig getifaddr en0` (Mac) or `ipconfig` (Windows)
   - Visit: `http://[your-ip]:5174`
   - Phone and computer must be on same WiFi

### Production Build
```bash
npm run build
```
Creates optimized version in `dist/` folder.

---

## 📝 Common Tasks

### Task: Change a Patient's Name
**File:** `src/components/LuminaryDemo.jsx`
**Lines:** ~62-65 (the `const patients = [...]` section)

```javascript
// Find this:
{ id: 1, name: 'Alice Johnson', ...}

// Change to:
{ id: 1, name: 'Your Patient Name', ...}
```

### Task: Add a New Patient
**File:** `src/components/LuminaryDemo.jsx`

```javascript
const patients = [
  { id: 1, ... },
  { id: 2, ... },
  // Add this:
  { id: 5, name: 'New Patient', phone: '+263 ...', insurance: 'NH263 Plan A', ... },
];
```

### Task: Change Appointment Time
**File:** `src/components/LuminaryDemo.jsx`

```javascript
const appointments = [
  { id: 1, ..., time: '10:00', ... },  // Change '10:00' to whatever
];
```

### Task: Change Invoice Amount
**File:** `src/components/LuminaryDemo.jsx`

```javascript
const invoices = [
  { id: 'INV-001', ..., amount: 1500, ... },  // Change 1500
];
```

---

## 🐛 Troubleshooting

### "Changes not showing"
1. Hard refresh browser: `Ctrl+R` or `Cmd+R`
2. Check console for errors: `F12` → Console tab
3. Check that you edited the right file
4. Restart local frontend server: `Ctrl+C` then `npm run dev`

### "Styles look wrong"
1. Make sure `src/index.css` exists and imports Tailwind
2. Restart local frontend server
3. Hard refresh browser

### "Component not showing"
1. Check that component is imported in `App.jsx`
2. Check for JavaScript errors in console: `F12` → Console
3. Make sure file path is correct

### "npm install failed"
```bash
rm -rf node_modules package-lock.json
npm install
```

---

## 📚 Learning Path

**New to React?**
1. Read code comments in `src/components/LuminaryDemo.jsx`
2. Try making small changes (patient names, amounts)
3. Check how React hooks work: `useState`, component structure
4. Move to Stage 2 documentation (coming)

**New to Tailwind CSS?**
1. Tailwind is utility-first CSS: classes like `bg-blue-500`, `text-lg`
2. See `tailwind.config.js` for color scheme
3. Modify classes in JSX to change styling
4. Reference: https://tailwindcss.com/docs

**New to Vite?**
1. Vite is just a fast build tool
2. You don't need to configure it (it's done)
3. Just edit files, browser updates automatically
4. Reference: https://vitejs.dev/guide/

---

## 🎯 Next Priorities

**Before Moving to Stage 2:**
1. ✅ Project set up and running
2. ✅ Customize with practice name
3. ✅ Demo to first practice
4. ✅ Collect feedback

**What Feedback Should Tell You:**
- "Can I change patient info?" → Stage 2 (state management)
- "Can this save data?" → Stage 3 (API integration)
- "Can it connect to our current system?" → Stage 3 (API)
- "Who logs in?" → Stage 5 (authentication)

---

## 🚀 Moving to Stage 2

When you're ready for interactive features (Stage 2):

1. Extract data from component
2. Add useState hooks for each data type
3. Add form components for creating/editing
4. Save to localStorage

See `README.md` for full Stage 2 plan.

---

## 📞 Questions?

**About the code?** Check inline comments in files.
**About structure?** See `README.md` for architecture.
**About CSS?** See Tailwind documentation.
**About React?** See React documentation.

---

## 💡 Pro Tips

1. **Search across project:** `Ctrl+Shift+F` in VSCode
2. **Find hardcoded data:** Search for "const patients"
3. **Test responsiveness:** `F12` → Device Toolbar → Select device
4. **Performance:** Changes should show <1 second after saving
5. **Git commits:** Make small, focused commits as you change things

---

Good luck! Build something amazing. 🚀
