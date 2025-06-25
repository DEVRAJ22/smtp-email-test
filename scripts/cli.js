#!/usr/bin/env node

import { EmailVerifier } from "./email-verifier.js"
import { AdvancedEmailVerifier } from "./advanced-email-verifier.js"
import { BulkEmailProcessor } from "./bulk-email-processor.js"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Get package.json for version info
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"))

function showHelp() {
  console.log(`
Node.js Email Verifier v${packageJson.version}

Usage: node scripts/cli.js [command] [options]

Commands:
  verify <email>              Verify a single email address
  bulk <file>                 Verify emails from a file (txt, csv, json)
  demo                        Run demonstration with sample emails
  help                        Show this help message

Options:
  --timeout <ms>              Connection timeout (default: 10000)
  --debug                     Enable debug logging
  --concurrency <n>           Number of concurrent verifications (default: 3)
  --delay <ms>                Delay between batches (default: 2000)
  --from <email>              From email address for SMTP (default: test@example.com)
  --cache-expiry <ms>         Cache expiry time (default: 3600000)
  --rate-limit <n>            Max requests per domain (default: 10)
  --output <file>             Output file for results

Examples:
  node scripts/cli.js verify user@example.com
  node scripts/cli.js verify user@example.com --debug
  node scripts/cli.js bulk emails.txt --output results.json
  node scripts/cli.js demo
`)
}

function parseArgs(args) {
  const options = {
    timeout: 10000,
    debug: false,
    concurrency: 3,
    delay: 2000,
    fromEmail: "test@example.com",
    cacheExpiry: 3600000,
    maxRequestsPerDomain: 10,
    output: null,
  }

  const command = args[0]
  const target = args[1]

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case "--timeout":
        options.timeout = Number.parseInt(args[i + 1]) || options.timeout
        i++
        break
      case "--debug":
        options.debug = true
        break
      case "--concurrency":
        options.concurrency = Number.parseInt(args[i + 1]) || options.concurrency
        i++
        break
      case "--delay":
        options.delay = Number.parseInt(args[i + 1]) || options.delay
        i++
        break
      case "--from":
        options.fromEmail = args[i + 1] || options.fromEmail
        i++
        break
      case "--cache-expiry":
        options.cacheExpiry = Number.parseInt(args[i + 1]) || options.cacheExpiry
        i++
        break
      case "--rate-limit":
        options.maxRequestsPerDomain = Number.parseInt(args[i + 1]) || options.maxRequestsPerDomain
        i++
        break
      case "--output":
        options.output = args[i + 1]
        i++
        break
    }
  }

  return { command, target, options }
}

async function verifySingleEmail(email, options) {
  console.log(`Verifying email: ${email}`)
  console.log("Options:", JSON.stringify(options, null, 2))
  console.log("---")

  const verifier = new EmailVerifier(options)

  try {
    const result = await verifier.verifyEmail(email)

    console.log("\nResult:")
    console.log(`Email: ${result.email}`)
    console.log(`Valid: ${result.isValid ? "✅ Yes" : "❌ No"}`)
    console.log(`Status: ${result.status}`)
    console.log(`Message: ${result.message}`)

    if (result.smtpResponse) {
      console.log(`SMTP Response: ${result.smtpResponse}`)
    }

    if (options.output) {
      const fs = await import("fs/promises")
      await fs.writeFile(options.output, JSON.stringify(result, null, 2))
      console.log(`\nResult saved to: ${options.output}`)
    }
  } catch (error) {
    console.error("Error:", error.message)
    process.exit(1)
  }
}

async function verifyBulkEmails(filePath, options) {
  console.log(`Processing emails from: ${filePath}`)
  console.log("Options:", JSON.stringify(options, null, 2))
  console.log("---")

  const processor = new BulkEmailProcessor(options)

  try {
    // Load emails from file
    const emails = await processor.loadEmailsFromFile(filePath)
    console.log(`Loaded ${emails.length} emails from file`)

    if (emails.length === 0) {
      console.log("No valid emails found in file")
      return
    }

    // Process emails
    const results = await processor.processBulkEmails(emails)

    // Generate report
    const report = processor.generateDetailedReport(results)

    console.log("\n=== VERIFICATION REPORT ===")
    console.log(`Total emails: ${report.summary.total}`)
    console.log(`Valid: ${report.summary.valid} (${report.summary.validPercentage}%)`)
    console.log(`Invalid: ${report.summary.invalid} (${report.summary.invalidPercentage}%)`)
    console.log(`Errors: ${report.summary.errors}`)
    console.log(`Temporary failures: ${report.summary.temporary}`)

    if (report.domainAnalysis.topDomains.length > 0) {
      console.log("\nTop domains:")
      report.domainAnalysis.topDomains.forEach((domain, index) => {
        console.log(`${index + 1}. ${domain.domain}: ${domain.total} emails, ${domain.validRate} valid`)
      })
    }

    if (report.recommendations.length > 0) {
      console.log("\nRecommendations:")
      report.recommendations.forEach((rec, index) => {
        console.log(`${index + 1}. ${rec}`)
      })
    }

    // Save results
    const outputFile = options.output || `verification_results_${Date.now()}.json`
    await processor.saveResults(results, outputFile)

    // Also save CSV
    const csvFile = outputFile.replace(".json", ".csv")
    const fs = await import("fs/promises")
    const csvContent = [
      "Email,IsValid,Status,Message,SMTPResponse",
      ...results.map((r) => `"${r.email}",${r.isValid},"${r.status}","${r.message}","${r.smtpResponse || ""}"`),
    ].join("\n")

    await fs.writeFile(csvFile, csvContent)
    console.log(`\nResults saved to: ${outputFile}`)
    console.log(`CSV exported to: ${csvFile}`)
  } catch (error) {
    console.error("Error:", error.message)
    process.exit(1)
  }
}

async function runDemo(options) {
  console.log("Running Email Verifier Demo")
  console.log("Options:", JSON.stringify(options, null, 2))
  console.log("---")

  const verifier = new AdvancedEmailVerifier(options)

  const sampleEmails = [
    "test@gmail.com",
    "user@yahoo.com",
    "invalid-email-format",
    "admin@example.com",
    "nonexistent@gmail.com",
  ]

  console.log(`Testing ${sampleEmails.length} sample emails...\n`)

  const results = []

  for (const email of sampleEmails) {
    console.log(`Verifying: ${email}`)
    try {
      const result = await verifier.verifyEmailAdvanced(email)
      results.push(result)

      const status = result.isValid ? "✅ Valid" : "❌ Invalid"
      console.log(`  Result: ${status} (${result.status})`)
      console.log(`  Message: ${result.message}`)

      if (result.fromCache) {
        console.log("  📋 From cache")
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`)
      results.push({
        email,
        isValid: false,
        status: "error",
        message: error.message,
      })
    }
    console.log()
  }

  // Generate summary
  const validCount = results.filter((r) => r.isValid).length
  const invalidCount = results.filter((r) => !r.isValid && r.status !== "error").length
  const errorCount = results.filter((r) => r.status === "error").length

  console.log("=== DEMO SUMMARY ===")
  console.log(`Total tested: ${results.length}`)
  console.log(`Valid: ${validCount}`)
  console.log(`Invalid: ${invalidCount}`)
  console.log(`Errors: ${errorCount}`)

  if (options.output) {
    const fs = await import("fs/promises")
    await fs.writeFile(options.output, JSON.stringify(results, null, 2))
    console.log(`\nDemo results saved to: ${options.output}`)
  }
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    showHelp()
    return
  }

  const { command, target, options } = parseArgs(args)

  try {
    switch (command) {
      case "verify":
        if (!target) {
          console.error("Error: Email address required for verify command")
          console.log("Usage: node scripts/cli.js verify <email>")
          process.exit(1)
        }
        await verifySingleEmail(target, options)
        break

      case "bulk":
        if (!target) {
          console.error("Error: File path required for bulk command")
          console.log("Usage: node scripts/cli.js bulk <file>")
          process.exit(1)
        }
        await verifyBulkEmails(target, options)
        break

      case "demo":
        await runDemo(options)
        break

      default:
        console.error(`Error: Unknown command '${command}'`)
        showHelp()
        process.exit(1)
    }
  } catch (error) {
    console.error("Fatal error:", error.message)
    if (options.debug) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

// Run CLI if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}

export { main as runCLI }
