export type MaintenanceContext = {
	readonly mode: 'rescue_superadmin';
	readonly [key: string]: unknown;
};

export type MaintenanceActionResult = string | { message: string } | Record<string, unknown> | undefined;

export type MaintenanceAction = {
	key: string;
	label: string;
	description?: string;
	confirm?: string;
	run: (context: MaintenanceContext) => Promise<MaintenanceActionResult> | MaintenanceActionResult;
};

export type MaintenanceGroup = {
	key: string;
	label: string;
	actions: MaintenanceAction[];
};
