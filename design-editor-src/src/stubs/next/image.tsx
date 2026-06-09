export default function Image({ src, alt, ...props }: any) {
  return <img src={src} alt={alt} {...props} />;
}
