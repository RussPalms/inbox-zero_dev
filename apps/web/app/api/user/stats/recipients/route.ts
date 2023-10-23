import { NextResponse } from "next/server";
import { z } from "zod";
import countBy from "lodash/countBy";
import sortBy from "lodash/sortBy";
import { gmail_v1 } from "googleapis";
import { getAuthSession } from "@/utils/auth";
// import { getGmailClient } from "@/utils/gmail/client";
import { parseMessage } from "@/utils/mail";
import { getMessage } from "@/utils/gmail/message";
import { parseDomain } from "@/app/api/user/stats/senders/route";
import {
  getDomainsMostSentTo,
  getMostSentTo,
  zodPeriod,
} from "@inboxzero/tinybird";

const recipientStatsQuery = z.object({
  period: zodPeriod,
  fromDate: z.coerce.number().nullish(),
  toDate: z.coerce.number().nullish(),
});
export type RecipientStatsQuery = z.infer<typeof recipientStatsQuery>;
export type RecipientsResponse = Awaited<ReturnType<typeof getRecipients>>;

async function getRecipients(options: { gmail: gmail_v1.Gmail }) {
  const { gmail } = options;

  const res = await gmail.users.messages.list({
    userId: "me",
    q: `in:sent`,
    maxResults: 50,
  });

  // be careful of rate limiting here
  const messages = await Promise.all(
    res.data.messages?.map(async (m) => {
      const message = await getMessage(m.id!, gmail);
      const parsedMessage = parseMessage(message);

      return {
        ...message,
        parsedMessage,
      };
    }) || []
  );

  const countByRecipient = countBy(messages, (m) => m.parsedMessage.headers.to);
  const countByDomain = countBy(messages, (m) =>
    parseDomain(m.parsedMessage.headers.to)
  );

  const mostActiveRecipientEmails = sortBy(
    Object.entries(countByRecipient),
    ([, count]) => -count
  ).map(([recipient, count]) => ({
    name: recipient,
    value: count,
  }));

  const mostActiveRecipientDomains = sortBy(
    Object.entries(countByDomain),
    ([, count]) => -count
  ).map(([recipient, count]) => ({
    name: recipient,
    value: count,
  }));

  return { mostActiveRecipientEmails, mostActiveRecipientDomains };
}

async function getRecipientsTinybird(
  options: RecipientStatsQuery & {
    ownerEmail: string;
  }
): Promise<RecipientsResponse> {
  const [mostReceived, mostReceivedDomains] = await Promise.all([
    getMostSentTo(options),
    getDomainsMostSentTo(options),
  ]);

  return {
    mostActiveRecipientEmails: mostReceived.data.map((d) => ({
      name: d.to,
      value: d.count,
    })),
    mostActiveRecipientDomains: mostReceivedDomains.data.map((d) => ({
      name: d.to,
      value: d.count,
    })),
  };
}

export async function GET(request: Request) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" });

  // const gmail = getGmailClient(session);

  const { searchParams } = new URL(request.url);
  const query = recipientStatsQuery.parse({
    period: searchParams.get("period") || "week",
    fromDate: searchParams.get("fromDate"),
    toDate: searchParams.get("toDate"),
  });

  // const result = await getRecipients({ gmail });
  const result = await getRecipientsTinybird({
    ownerEmail: session.user.email,
    ...query,
  });

  return NextResponse.json(result);
}
