import {
    Action,
    IAgentRuntime,
    Memory,
    generateObjectDeprecated,
    ModelClass,
    composeContext,
    elizaLogger,
} from "@elizaos/core";
import {
    BaseParadexState,
    getParadexConfig,
    getAccount,
    ParadexAuthenticationError,
} from "../utils/paradexUtils";
import { Account } from "../utils/paradex-ts/types";
import { authenticate } from "../utils/paradex-ts/api";
import { z } from "zod";

interface CancelOrderRequest {
    orderId: string;
}

const cancelOrderTemplate = `Analyze ONLY the latest user message to extract the order ID to cancel.
Last message: "{{lastMessage}}"

The order ID should be extracted from the message.
Examples of valid messages:
- "Cancel order 1389374042600201783749284920"
- "Remove order 1723728042600201727492050274"
- "Cancel       1380374042600201703991150000"

Respond with a JSON markdown block containing ONLY the order ID from the last message:
\`\`\`json
{
  "orderId": "1738437810829483947293473202"
}
\`\`\`
`;

export class ParadexCancelError extends Error {
    constructor(message: string, public details?: any) {
        super(message);
        this.name = "ParadexCancelError";
    }
}

async function cancelOrder(
    config,
    account: Account,
    orderId: string
): Promise<boolean> {
    try {
        const response = await fetch(`${config.apiBaseUrl}/orders/${orderId}`, {
            method: "DELETE",
            headers: {
                Authorization: `Bearer ${account.jwtToken}`,
                Accept: "application/json",
            },
        });

        if (response.status === 204) {
            elizaLogger.success(`Successfully cancelled order ${orderId}`);
            return true;
        }

        if (!response.ok) {
            let errorData;
            try {
                errorData = await response.json();
            } catch {
                errorData = "Could not parse error response";
            }
            throw new ParadexCancelError(
                `Failed to cancel order: ${response.status} ${response.statusText}`,
                errorData
            );
        }

        return false;
    } catch (error) {
        if (
            error instanceof ParadexCancelError ||
            error instanceof ParadexAuthenticationError
        ) {
            throw error;
        }
        elizaLogger.error(`Error cancelling order ${orderId}:`, error);
        throw new ParadexCancelError(
            "Failed to cancel order",
            error instanceof Error ? error.message : error
        );
    }
}

async function extractOrderId(
    runtime: IAgentRuntime,
    state: BaseParadexState
): Promise<string> {
    const context = composeContext({
        state,
        template: cancelOrderTemplate,
    });

    const response = (await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    })) as CancelOrderRequest;

    if (!response?.orderId) {
        throw new ParadexCancelError("No order ID found in message");
    }

    return response.orderId;
}

export const paradexCancelOrderAction: Action = {
    name: "CANCEL_PARADEX_ORDER",
    similes: ["CANCEL_ORDER", "REMOVE_ORDER", "DELETE_ORDER"],
    description: "Cancels a specific order on Paradex",
    suppressInitialMessage: true,

    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const text = message.content?.text?.toLowerCase() || "";
        return text.includes("cancel") || text.includes("remove");
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: BaseParadexState
    ) => {
        elizaLogger.info("Starting cancel order process...");

        try {
            // Initializing the state
            if (!state) {
                state = {} as BaseParadexState;
            }

            const config = getParadexConfig();
            const account = await getAccount(runtime);
            
            try {
                account.jwtToken = await authenticate(config, account);
            } catch (error) {
                elizaLogger.error("Authentication failed:", error);
                throw new ParadexAuthenticationError(
                    "Failed to authenticate with Paradex",
                    error
                );
            }
            elizaLogger.success("Account retrieved and JWT token generated");

            // Update state with latest message
            state.lastMessage = message.content.text;

            // Extract order ID from message
            const orderId = await extractOrderId(runtime, state);
            elizaLogger.success("Order ID extracted:", orderId);

            // Execute cancel order
            const success = await cancelOrder(config, account, orderId);

            if (success) {
                elizaLogger.success(`Order ${orderId} cancelled successfully`);
                return true;
            } else {
                elizaLogger.warn(`Failed to cancel order ${orderId}`);
                return false;
            }
        } catch (error) {
            if (error instanceof ParadexAuthenticationError) {
                elizaLogger.error("Authentication failed:", error.details);
            } else if (error instanceof ParadexCancelError) {
                elizaLogger.error("Cancel order error:", error.details);
            } else if (error instanceof z.ZodError) {
                elizaLogger.error(
                    "Configuration validation error:",
                    error.errors
                );
            } else {
                elizaLogger.error(
                    "Unexpected error during order cancellation:",
                    error
                );
            }
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Cancel order abc123" },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Order cancelled successfully.",
                    action: "CANCEL_PARADEX_ORDER",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Please remove order: xyz789" },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Order cancelled.",
                    action: "CANCEL_PARADEX_ORDER",
                },
            },
        ],
    ],
};
