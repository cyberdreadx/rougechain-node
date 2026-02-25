/** @type {import('tailwindcss').Config} */
export default {
    content: ["./src/**/*.{js,ts,jsx,tsx}", "./popup.html"],
    theme: {
        extend: {
            colors: {
                background: "hsl(220 20% 4%)",
                foreground: "hsl(180 100% 95%)",
                card: "hsl(220 25% 8%)",
                "card-foreground": "hsl(180 100% 95%)",
                primary: "hsl(175 85% 50%)",
                "primary-foreground": "hsl(220 20% 4%)",
                secondary: "hsl(220 30% 15%)",
                "secondary-foreground": "hsl(180 100% 90%)",
                muted: "hsl(220 25% 12%)",
                "muted-foreground": "hsl(200 15% 55%)",
                accent: "hsl(280 80% 60%)",
                "accent-foreground": "hsl(0 0% 100%)",
                destructive: "hsl(0 75% 55%)",
                success: "hsl(150 80% 45%)",
                warning: "hsl(45 100% 55%)",
                border: "hsl(220 30% 18%)",
                input: "hsl(220 30% 15%)",
                ring: "hsl(175 85% 50%)",
            },
            fontFamily: {
                sans: ["Inter", "system-ui", "sans-serif"],
                mono: ["JetBrains Mono", "monospace"],
            },
        },
    },
    plugins: [],
};
