import { h } from "vue"
import * as frappeUI from "frappe-ui"

export const COMPONENTS = {
	Alert: {
		name: "Alert",
		title: "Alert",
		icon: "CircleAlert",
		initialState: {
			title: "This user is inactive",
			type: "warning",
		},
	},
	Autocomplete: {
		name: "Autocomplete",
		title: "Autocomplete",
		icon: "TextSearch",
		initialState: {
			placeholder: "Select Person",
			options: [
				{
					label: "John Doe",
					value: "john-doe",
					image: "https://randomuser.me/api/portraits/men/59.jpg",
				},
				{
					label: "Jane Doe",
					value: "jane-doe",
					image: "https://randomuser.me/api/portraits/women/58.jpg",
				},
				{
					label: "John Smith",
					value: "john-smith",
					image: "https://randomuser.me/api/portraits/men/59.jpg",
				},
				{
					label: "Jane Smith",
					value: "jane-smith",
					image: "https://randomuser.me/api/portraits/women/59.jpg",
				},
				{
					label: "John Wayne",
					value: "john-wayne",
					image: "https://randomuser.me/api/portraits/men/57.jpg",
				},
				{
					label: "Jane Wayne",
					value: "jane-wayne",
					image: "https://randomuser.me/api/portraits/women/51.jpg",
				},
			],
		},
	},
	Avatar: {
		name: "Avatar",
		title: "Avatar",
		icon: "User",
		initialState: {
			shape: "circle",
			size: "md",
			image: "https://avatars.githubusercontent.com/u/499550?s=60&v=4",
			label: "EY",
		},
	},
	Badge: {
		name: "Badge",
		title: "Badge",
		icon: "BadgeCheck",
		initialState: {
			variant: "subtle",
			theme: "green",
			size: "sm",
			label: "Active",
		},
	},
	Button: {
		name: "Button",
		title: "Button",
		icon: "RectangleHorizontal",
		initialState: {
			label: "Submit",
			variant: "solid",
		},
	},
	Card: {
		name: "Card",
		title: "Card",
		icon: "IdCard",
		initialState: {
			title: "John Doe",
			subtitle: "Engineering Lead",
		},
	},
	Checkbox: {
		name: "Checkbox",
		title: "Checkbox",
		icon: "CircleCheck",
		initialState: {
			label: "Enable feature",
			padding: true,
			checked: true,
		},
	},
	DatePicker: {
		name: "DatePicker",
		title: "Date",
		icon: "CalendarCheck",
		initialState: {
			placeholder: "Select Date",
		},
	},
	DateTimePicker: {
		name: "DateTimePicker",
		title: "Date Time",
		icon: "CalendarClock",
		initialState: {
			placeholder: "Select Date Time",
		},
	},
	DateRangePicker: {
		name: "DateRangePicker",
		title: "Date Range",
		icon: "CalendarSearch",
		initialState: {
			placeholder: "Select Date Range",
		},
	},
	Dialog: {
		name: "Dialog",
		title: "Dialog",
		icon: "AppWindowMac",
		initialState: {
			options: {
				title: "Confirm",
				message: "Are you sure you want to confirm this action?",
				size: "xl",
				actions: [
					{
						label: "Confirm",
						variant: "solid",
						onClick: () => {},
					},
				],
			},
		},
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
		initialState: {
			options: [
				{
					label: "Edit Title",
					onClick: () => {},
					icon: () => h(frappeUI.FeatherIcon, { name: "edit-2" }),
				},
				{
					label: "Manage Members",
					onClick: () => {},
					icon: () => h(frappeUI.FeatherIcon, { name: "users" }),
				},
				{
					label: "Delete this project",
					onClick: () => {},
					icon: () => h(frappeUI.FeatherIcon, { name: "trash" }),
				},
			],
		},
	},
	ErrorMessage: {
		name: "ErrorMessage",
		title: "Error Message",
		icon: "CircleX",
		initialState: {
			message: "Transaction failed due to insufficient balance",
		},
	},
	FileUploader: {
		name: "FileUploader",
		title: "File Uploader",
		icon: "FileUp",
		initialState: {
			label: "Upload File",
			fileTypes: "['image/*']",
		},
	},
	FormControl: {
		name: "FormControl",
		title: "Form Control",
		icon: "BookType",
		initialState: {
			type: "text",
			label: "Name",
			placeholder: "John Doe",
			autocomplete: "off",
		},
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
					getLabel: function ({ row }) {
						return row.name
					},
					prefix: function ({ row }) {
						return h(frappeUI.Avatar, {
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
		},
	},
	Progress: {
		name: "Progress",
		title: "Progress",
		icon: "Ellipsis",
		initialState: {
			value: 50,
			size: "sm",
			label: "Progress",
		},
	},
	Select: {
		name: "Select",
		title: "Select",
		icon: "MousePointer2",
		initialState: {
			placeholder: "Person",
			options: [
				{
					label: "John Doe",
					value: "john-doe",
				},
				{
					label: "Jane Doe",
					value: "jane-doe",
				},
				{
					label: "John Smith",
					value: "john-smith",
				},
				{
					label: "Jane Smith",
					value: "jane-smith",
					disabled: true,
				},
				{
					label: "John Wayne",
					value: "john-wayne",
				},
				{
					label: "Jane Wayne",
					value: "jane-wayne",
				},
			],
		},
	},
	Switch: {
		name: "Switch",
		title: "Switch",
		icon: "ToggleLeft",
		initialState: {
			label: "Enable Notifications",
			description: "Get notified when someone mentions you in a comment",
			modelValue: true,
		},
	},
	Tabs: {
		name: "Tabs",
		title: "Tabs",
		icon: "ArrowRightLeft",
		initialState: {
			tabs: [
				{
					label: "Github",
					content:
						"Github is a code hosting platform for version control and collaboration. It lets you and others work together on projects from anywhere.",
				},
				{
					label: "Twitter",
					content:
						'Twitter is an American microblogging and social networking service on which users post and interact with messages known as "tweets".',
				},
				{
					label: "Linkedin",
					content:
						"LinkedIn is an American business and employment-oriented online service that operates via websites and mobile apps.",
				},
			],
		},
	},
	Textarea: {
		name: "Textarea",
		title: "Textarea",
		icon: "LetterText",
		initialState: {
			placeholder: "Enter your message",
		},
	},
	TextInput: {
		name: "TextInput",
		title: "Text Input",
		icon: "ALargeSmall",
		initialState: {
			placeholder: "Enter your name",
		},
	},
	Tooltip: {
		name: "Tooltip",
		title: "Tooltip",
		icon: "MessageSquare",
		initialState: {
			text: "This is a tooltip",
		},
	},
	Tree: {
		name: "Tree",
		title: "Tree",
		icon: "ListTree",
		initialState: {
			options: {
				showIndentationGuides: true,
				rowHeight: "25px",
				indentWidth: "15px",
			},
			nodeKey: "name",
			node: {
				name: "guest",
				label: "Guest",
				children: [
					{
						name: "downloads",
						label: "Downloads",
						children: [
							{
								name: "download.zip",
								label: "download.zip",
								children: [
									{
										name: "image.png",
										label: "image.png",
										children: [],
									},
								],
							},
						],
					},
					{
						name: "documents",
						label: "Documents",
						children: [
							{
								name: "somefile.txt",
								label: "somefile.txt",
								children: [],
							},
							{
								name: "somefile.pdf",
								label: "somefile.pdf",
								children: [],
							},
						],
					},
				],
			},
		},
	},
}

function get(name) {
	return COMPONENTS[name]
}

function getComponent(name) {
	return frappeUI[name]
}

function getProps(name) {
	return frappeUI[name]?.props
}

export default {
	...COMPONENTS,
	list: Object.values(COMPONENTS),
	get,
	getComponent,
	getProps,
}
