import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Custom hook for persisting state in localStorage
 * @param key - localStorage key
 * @param initialValue - Initial value if key doesn't exist
 * @returns [storedValue, setValue] tuple
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  // Read once on mount (lazy initialiser) instead of on every render.
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initialValue;
    try {
      const item = window.localStorage.getItem(key);
      return item !== null ? (JSON.parse(item) as T) : initialValue;
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  // Skip the initial write: the value either came from storage or is the default.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(storedValue));
    } catch (error) {
      console.warn(`Error setting localStorage key "${key}":`, error);
    }
  }, [key, storedValue]);

  // Stable setter that always applies functional updates to the latest state,
  // so several updates in the same tick no longer overwrite one another.
  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    setStoredValue((prev) => (value instanceof Function ? value(prev) : value));
  }, []);

  // Handle storage changes from other tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        try {
          setStoredValue(JSON.parse(e.newValue));
        } catch (error) {
          console.warn(`Error parsing localStorage change for key "${key}":`, error);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [key]);

  return [storedValue, setValue];
}

/**
 * Custom hook for debouncing a value
 * @param value - Value to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced value
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

/**
 * Custom hook for debouncing a callback function
 * @param callback - Function to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced function
 */
export function useDebouncedCallback<T extends (...args: unknown[]) => unknown>(
  callback: T,
  delay: number
): (...args: Parameters<T>) => void {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);

  // Update callback ref when callback changes
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        callbackRef.current(...args);
      }, delay);
    },
    [delay]
  );
}

/**
 * Custom hook for handling async operations with loading state
 * @param asyncFn - Async function to execute
 * @returns { execute, loading, error, data }
 */
export function useAsync<T, Args extends unknown[]>(
  asyncFn: (...args: Args) => Promise<T>
): {
  execute: (...args: Args) => Promise<T | undefined>;
  loading: boolean;
  error: Error | null;
  data: T | null;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<T | null>(null);

  const execute = useCallback(
    async (...args: Args): Promise<T | undefined> => {
      setLoading(true);
      setError(null);
      try {
        const result = await asyncFn(...args);
        setData(result);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error('An unknown error occurred');
        setError(error);
        return undefined;
      } finally {
        setLoading(false);
      }
    },
    [asyncFn]
  );

  return { execute, loading, error, data };
}

/**
 * Custom hook for managing form state
 * @param initialValues - Initial form values
 * @returns { values, handleChange, handleSubmit, setValues, reset }
 */
export function useForm<T extends Record<string, unknown>>(
  initialValues: T
): {
  values: T;
  handleChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
  handleBlur: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
  setValues: (values: T | ((prev: T) => T)) => void;
  reset: () => void;
  errors: Partial<Record<keyof T, string>>;
  setError: (field: keyof T, error: string) => void;
  clearError: (field: keyof T) => void;
} {
  const [values, setValues] = useState<T>(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const { name, value, type } = e.target;
      const parsedValue = type === 'number' ? (value === '' ? 0 : Number(value)) : value;
      setValues((prev) => ({ ...prev, [name]: parsedValue }));
      // Clear error on change (only re-render if there was one)
      setErrors((prev) => (prev[name as keyof T] ? { ...prev, [name]: undefined } : prev));
    },
    []
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      // Can be extended for validation on blur
    },
    []
  );

  const setError = useCallback((field: keyof T, error: string) => {
    setErrors((prev) => ({ ...prev, [field]: error }));
  }, []);

  const clearError = useCallback((field: keyof T) => {
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }, []);

  const reset = useCallback(() => {
    setValues(initialValues);
    setErrors({});
  }, [initialValues]);

  return {
    values,
    handleChange,
    handleBlur,
    setValues,
    reset,
    errors,
    setError,
    clearError,
  };
}

/**
 * Custom hook for keyboard shortcuts
 * @param key - Key to listen for
 * @param callback - Callback to execute
 * @param modifiers - Modifier keys (ctrl, shift, alt, meta)
 */
export function useHotkey(
  key: string,
  callback: () => void,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}
): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === key.toLowerCase() &&
        !!e.ctrlKey === !!modifiers.ctrl &&
        !!e.shiftKey === !!modifiers.shift &&
        !!e.altKey === !!modifiers.alt &&
        !!e.metaKey === !!modifiers.meta
      ) {
        e.preventDefault();
        callback();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [key, callback, modifiers.ctrl, modifiers.shift, modifiers.alt, modifiers.meta]);
}

/**
 * Custom hook for detecting click outside an element
 * @param ref - Ref to the element
 * @param handler - Handler to call when clicking outside
 */
export function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  handler: (event: MouseEvent | TouchEvent) => void
): void {
  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent) => {
      if (!ref.current || ref.current.contains(event.target as Node)) {
        return;
      }
      handler(event);
    };

    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);

    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, handler]);
}

/**
 * Custom hook for media queries
 * @param query - Media query string
 * @returns Whether the query matches
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const media = window.matchMedia(query);
    setMatches(media.matches);

    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener('change', listener);

    return () => media.removeEventListener('change', listener);
  }, [query]);

  return matches;
}

/**
 * Custom hook for tracking window size
 * @returns { width, height }
 */
export function useWindowSize(): { width: number; height: number } {
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return windowSize;
}