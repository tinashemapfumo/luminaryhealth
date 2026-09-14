# International Email Claims Workflow

## Purpose

Some clients do not submit claims through NH263 claim switching. They prepare claim forms and send them by email to international medical aid providers. Luminary Health should support this as a first-class claim submission channel, not as an exception inside the NH263 switch flow.

## Recommended MVP

Build a manual email submission module where Luminary staff prepare the claim form and document pack, then the client authenticates the claim before staff submit it to the international insurer by email.

The operational flow is:

1. Staff prepares the claim form from existing patient, invoice, diagnosis, tariff, and provider data.
2. Luminary generates or records the provider-specific claim form and required document checklist.
3. Staff sends a secure review link to the client.
4. Client reviews the form, confirms accuracy, accepts the declaration, and authenticates with OTP or portal login.
5. Luminary locks the claim pack and records the authentication evidence.
6. Staff sends the authenticated claim pack to the configured insurer email address.
7. Luminary tracks the email submission reference, follow-up date, replies, queries, outcome, and payment.

## Status Model

Email claims use these additional statuses:

- `Form prepared`
- `Awaiting client authentication`
- `Client authenticated`
- `Email submitted`

These statuses sit beside the existing switch statuses. A claim should also carry `submissionChannel: "Email"` so it can be filtered independently from NH263/switch claims.

## Claim Pack Data

Each email claim should store:

- Provider email address
- Provider-specific claim form name
- Prepared-by user
- Secure client review link
- Authentication method
- Authentication result and timestamp
- Required document list
- Actual attachments
- Email subject
- Sent timestamp
- Sent-by user
- Email message id or submission reference
- Follow-up rule

## Authentication Boundary

Staff may prepare the form on behalf of the client, but staff should not sign or approve it as if they were the client.

Preferred wording for generated packs:

> Prepared by Luminary Health on behalf of the member. Reviewed and authorised by the member before submission.

For the MVP, the recommended authentication evidence is:

- Client declaration checkbox
- OTP verification
- Timestamp
- Claim version/hash or locked PDF reference
- Client identity reference

## Implementation Notes

The front-end Claims page now includes an `Email` module for claim-by-email work. It supports the manual operational path:

- Prepare email route
- Send to client
- Record client authentication
- Submit by email

The current implementation is a persisted front-end simulation, consistent with the existing claims demo actions. Backend implementation should later add:

- Provider email configuration
- PDF generation or PDF form filling
- Secure client review portal
- OTP service
- Immutable claim pack versioning
- Email gateway integration through Microsoft 365, Google Workspace, or SMTP
- Incoming email matching to claim id/member/invoice
- Audit table entries for preparation, authentication, and submission

## Compliance Considerations

International claims may involve POPIA, GDPR, HIPAA-like insurer requirements, or country-specific data handling rules. The production version should avoid raw claim packs in ordinary email where the provider supports secure upload or encrypted mail. The client authentication record must be retained with the claim because email does not provide the same delivery proof as a formal claims switch.
