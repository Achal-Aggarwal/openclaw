// Fast help renderer for setup/onboard/configure without loading full CLI startup.
import { Command, CommanderError } from "commander";
import { VERSION } from "../version.js";
import { getCommandPathWithRootOptions } from "./argv.js";
import { configureProgramHelp } from "./program/help.js";

export async function outputSetupOnboardConfigureHelp(argv: string[]): Promise<void> {
  // Register only the requested command so help stays quick and avoids config/plugin startup.
  const program = new Command();
  program.enablePositionalOptions();
  program.exitOverride();
  configureProgramHelp(program, { programVersion: VERSION });
  const [command] = getCommandPathWithRootOptions(argv, 1);
  if (command === "setup") {
    const { registerSetupCommand } = await import("./program/register.setup.js");
    registerSetupCommand(program);
  } else if (command === "onboard") {
    const { registerOnboardCommand } = await import("./program/register.onboard.js");
    registerOnboardCommand(program);
  } else {
    const { registerConfigureCommand } = await import("./program/register.configure.js");
    registerConfigureCommand(program);
  }

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
}
