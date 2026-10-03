import { defineConfig } from '@pandacss/dev';
import { parkUIPreset } from '@park-ui/panda-preset';

export default defineConfig({
  preflight: true,
  presets: [parkUIPreset],
  include: ['./src/**/*.{ts,tsx}'],
  outdir: 'styled-system'
});
