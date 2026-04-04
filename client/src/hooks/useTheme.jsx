import { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

export const themes = {
  prism: {
    name: 'Prism',
    description: 'Blues, pinks & purples — light mode',
  },
  midnight: {
    name: 'Midnight',
    description: 'Cool dark mode',
  },
  ocean: {
    name: 'Ocean',
    description: 'Teals & blues — light mode',
  },
};

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('prism-theme') || 'prism';
    } catch {
      return 'prism';
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('prism-theme', theme);
    } catch {
      // localStorage unavailable
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
