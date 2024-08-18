import { h } from "vue"
import { Avatar } from "frappe-ui"

export const COMPONENTS = {
	Alert: {
		name: "Alert",
		title: "Alert",
		icon: "CircleAlert",
	},
	Autocomplete: {
		name: "Autocomplete",
		title: "Autocomplete",
		icon: "TextSearch",
	},
	Avatar: {
		name: "Avatar",
		title: "Avatar",
		icon: "User",
	},
	Badge: {
		name: "Badge",
		title: "Badge",
		icon: "BadgeCheck",
	},
	Button: {
		name: "Button",
		title: "Button",
		icon: "RectangleHorizontal",
		initialState: {
			label: "Button",
		},
	},
	Card: {
		name: "Card",
		title: "Card",
		icon: "IdCard",
	},
	Checkbox: {
		name: "Checkbox",
		title: "Checkbox",
		icon: "CircleCheck",
	},
	DatePicker: {
		name: "DatePicker",
		title: "Date",
		icon: "CalendarCheck",
	},
	DateTimePicker: {
		name: "DateTimePicker",
		title: "Date Time",
		icon: "CalendarClock",
	},
	DateRangePicker: {
		name: "DateRangePicker",
		title: "Date Range",
		icon: "CalendarSearch",
	},
	Dialog: {
		name: "Dialog",
		title: "Dialog",
		icon: "AppWindowMac",
	},
	Divider: {
		name: "Divider",
		title: "Divider",
		icon: "Minus",
	},
	Dropdown: {
		name: "Dropdown",
		title: "Dropdown",
		icon: "ChevronDown",
	},
	ListView: {
		name: "ListView",
		title: "List View",
		icon: "ListCheck",
		initialState: {
			columns: [
				{
					label: "Name",
					key: "name",
					width: 3,
					getLabel: ({ row }) => row.name,
					prefix: ({ row }) => {
						return h(Avatar, {
							shape: "circle",
							image: row.user_image,
							size: "sm",
						})
					},
				},
				{
					label: "Email",
					key: "email",
					width: "200px",
				},
				{
					label: "Role",
					key: "role",
				},
				{
					label: "Status",
					key: "status",
				},
			],
			rows: [
				{
					id: 1,
					name: "John Doe",
					email: "john@doe.com",
					status: "Active",
					role: "Developer",
					user_image: "https://avatars.githubusercontent.com/u/499550",
				},
				{
					id: 2,
					name: "Jane Doe",
					email: "jane@doe.com",
					status: "Inactive",
					role: "HR",
					user_image: "https://avatars.githubusercontent.com/u/499120",
				},
			],
			rowKey: "id",
			options: {
				selectable: true,
				showTooltip: true,
				resizeColumn: true,
			},
		},
	},
}

function get(name) {
	return COMPONENTS[name]
}

export default {
	...COMPONENTS,
	list: Object.values(COMPONENTS),
	get,
}
