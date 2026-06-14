import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, '../public');
const sourceFile = path.join(publicDir, 'script.js');
const targetFile = path.join(publicDir, 'script.min.js');

export async function obfuscateScript() {
  try {
    if (!fs.existsSync(sourceFile)) {
      return;
    }

    const sourceCode = fs.readFileSync(sourceFile, 'utf8');
    const { default: JavaScriptObfuscator } = await import(
      'javascript-obfuscator'
    );

    const obfuscationResult = JavaScriptObfuscator.obfuscate(sourceCode, {
      compact: true,
      controlFlowFlattening: false,
      numbersToExpressions: false,
      simplify: true,
      stringArrayThreshold: 0.5,
      splitStrings: false,
      unicodeEscapeSequence: false,
    });

    fs.writeFileSync(targetFile, obfuscationResult.getObfuscatedCode(), 'utf8');
  } catch (error) {}
}
