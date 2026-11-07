/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './*.html',
    './assets/js/**/*.js'
  ],
  theme: {
    extend: {
      colors: {
        gray: {
          750: '#2a3341'
        }
      }
    }
  },
  plugins: []
};
