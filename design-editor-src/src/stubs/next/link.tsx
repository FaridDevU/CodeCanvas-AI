export default function Link({ children, href, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
}
