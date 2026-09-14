# Variable Pricing Workflow

## Purpose

Some practices do not have fixed tariffs for every service. Pricing may depend on time, consumables, complexity, after-hours work, provider discretion, or contracted client arrangements. Luminary Health should support this without losing invoice integrity.

## Source Of Truth

The invoice line remains the final billing truth. A catalogue service can provide a standard price, but the saved invoice line records the final confirmed amount.

The model is:

1. Typed service description identifies what appears on the invoice.
2. Optional catalogue match links the line to a saved service when one exists.
3. Pricing mode explains how the amount was set.
4. Invoice line stores the final charged price and override context.
5. Claim, receipt, account statement, and reports derive from the invoice.

## MVP Pricing Modes

- `Standard price`: uses the catalogue price and locks the amount field.
- `Adjust standard price`: starts from the catalogue price, allows an edited amount, and requires a reason.
- `Custom price`: allows a manually entered amount for services without a fixed tariff, and requires a reason.

## Required Controls

When the amount is not the standard price, Luminary should store:

- Standard amount
- Final amount
- Pricing mode
- Reason
- Optional note
- User who captured the price
- Timestamp

Reasons currently supported:

- Consumables used
- Procedure complexity
- Extended consultation
- After-hours
- Provider discretion
- Contracted client rate
- Other

## Current Implementation

The invoice modal now makes the service description a required typed field. The catalogue dropdown is optional and is used only when the line should match a saved service. The modal also includes a pricing dropdown, standard-price display, editable amount handling, and reason capture. Saved invoice service lines store the pricing metadata, and the Billing detail view shows the override reason below the line.

This is a front-end implementation that fits the current persisted demo workspace. A production backend should enforce the same validation server-side and record price changes in the audit log.
